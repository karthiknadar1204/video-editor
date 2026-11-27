import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import postgres from "postgres";
import { mailbox, testDatabase, webOrigin } from "./local";

const password = "cutroom-test-password";

async function mailLink(request: APIRequestContext, email: string, subject: string) {
  const search = new URL("/api/v1/search", mailbox);
  search.searchParams.set("query", 'to:' + email + ' subject:"' + subject + '"');
  let messageId = "";
  await expect.poll(async () => {
    const result = await (await request.get(search.href)).json();
    messageId = result.messages?.[0]?.ID ?? "";
    return Boolean(messageId);
  }).toBe(true);
  const message = await (await request.get(mailbox + "/api/v1/message/" + messageId)).json();
  const link = new URL(message.Text.match(/https?:\/\/[^\s]+/)[0]);
  expect(link.origin).toBe(webOrigin);
  return link.href;
}

async function signup(page: Page, email: string, checkUnverifiedLogin = false) {
  await page.goto("/account?view=signup");
  await page.getByLabel("Name", { exact: true }).fill("Test editor");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create an account" }).click();
  await expect(page.getByRole("status")).toContainText("Check your inbox");
  expect((await page.request.get("/api/projects")).status()).toBe(401);
  if (checkUnverifiedLogin) {
    const unverified = await page.request.post("/api/auth/sign-in/email", { data: { email, password, callbackURL: "/projects" } });
    expect(unverified.status()).toBe(403);
  }
  await page.goto(await mailLink(page.request, email, "Verify your Cutroom email"));
  await expect(page.getByRole("heading", { name: "My projects" })).toBeVisible();
}

test("two verified accounts can reopen only their own projects and can sign out", async ({ page, browser, request }) => {
  await page.goto("/projects");
  await expect(page).toHaveURL(/\/account$/);
  await signup(page, randomUUID() + "@cutroom.test", true);
  await page.getByRole("button", { name: "New project" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Project title").fill("Morning interview");
  await dialog.getByLabel("Canvas format").selectOption("portrait");
  await dialog.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name: "Morning interview" })).toBeVisible();
  const projectPath = new URL(page.url()).pathname;
  await page.reload();
  await expect(page.getByText("720 × 1280 · 30 fps")).toBeVisible();
  const saved = await (await page.request.get("/api" + projectPath)).json();
  expect(saved).toMatchObject({ revision: 0, formatVersion: 1, timeline: { videoTrack: [], title: null, durationInFrames: 0 } });
  await page.getByRole("link", { name: "My projects" }).click();
  await page.getByRole("link", { name: /Morning interview/ }).click();
  await expect(page).toHaveURL(webOrigin + projectPath);

  const other = await browser.newContext({ baseURL: webOrigin });
  try {
    const b = await other.newPage();
    await signup(b, randomUUID() + "@cutroom.test");
    await expect(b.getByText("No projects yet")).toBeVisible();
    const create = await b.request.post("/api/projects", { data: { title: "Second project", format: "square" } });
    expect(create.status()).toBe(201);
    const { id } = await create.json();
    const second = await (await b.request.get("/api/projects/" + id)).json();
    expect(second.timeline).toMatchObject({ width: 1080, height: 1080 });
    expect((await b.request.get("/api" + projectPath)).status()).toBe(404);
    expect((await page.request.get("/api/projects/" + id)).status()).toBe(404);
    await b.goto(projectPath);
    await expect(b.getByRole("heading", { name: "Project unavailable" })).toBeVisible();
    for (const data of [{ title: "  ", format: "landscape" }, { title: "Other", format: "cinema" }, { title: "Other", format: "landscape", ownerId: "any" }]) {
      expect((await b.request.post("/api/projects", { data })).status()).toBe(400);
    }
  } finally { await other.close(); }
  const savedCookie = (await page.context().cookies()).map(c => c.name + "=" + c.value).join("; ");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/account$/);
  expect((await request.get("/api/projects", { headers: { cookie: savedCookie } })).status()).toBe(401);
});

test("a reset link works once and reset or expiry invalidates the old session", async ({ page, request }) => {
  const email = randomUUID() + "@cutroom.test";
  await signup(page, email);
  const beforeReset = (await page.context().cookies()).map(c => c.name + "=" + c.value).join("; ");

  async function signIn(pw: string) {
    await page.goto("/account");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(pw);
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  await page.goto("/account?view=forgot");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("status")).toContainText("a reset link");
  await page.goto(await mailLink(request, email, "Reset your Cutroom password"));
  const token = new URL(page.url()).searchParams.get("token");
  expect(token).toBeTruthy();
  const changed = password + "-changed";
  await page.getByLabel("New password").fill(changed);
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page.getByRole("status")).toContainText("password has been changed");
  expect((await request.get("/api/projects", { headers: { cookie: beforeReset } })).status()).toBe(401);
  const reused = await request.post("/api/auth/reset-password", { data: { token, newPassword: password } });
  expect(reused.status()).toBe(400);
  await signIn(password);
  await expect(page.getByRole("alert")).toBeVisible();
  await signIn(changed);
  await expect(page).toHaveURL(/\/projects$/);

  const db = postgres(testDatabase, { max: 1 });
  try {
    await db`UPDATE session SET expires_at = now() - interval '1 minute' WHERE user_id = (SELECT id FROM "user" WHERE email = ${email})`;
  } finally { await db.end(); }
  expect((await page.request.get("/api/projects")).status()).toBe(401);
  await page.reload();
  await expect(page).toHaveURL(/\/account$/);
});
