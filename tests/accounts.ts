import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { mailbox, webOrigin } from "./local";

export const password = "cutroom-test-password";

export async function mailLink(request: APIRequestContext, email: string, subject: string) {
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

async function waitForQuota<T extends { status(): number; headers(): Record<string,string> }>(send: () => Promise<T>) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await send();
    if (response.status() !== 429) return response;
    const seconds = Number(response.headers()["x-retry-after"] ?? 10);
    await new Promise(resolve => setTimeout(resolve, (seconds + 1) * 1000));
  }
  throw new Error("The local auth rate limit persisted across three retry windows.");
}

async function submitAuth(page: Page, button: string, path: string) {
  return waitForQuota(async () => {
    const [response] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith(path) && r.request().method() === "POST"),
      page.getByRole("button", { name:button, exact:true }).click(),
    ]);
    return response;
  });
}

export async function signIn(page: Page, email: string, pw: string) {
  await page.goto("/account");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact:true }).fill(pw);
  return submitAuth(page, "Sign in", "/api/auth/sign-in/email");
}

export async function signup(page: Page, email: string, checkUnverifiedLogin = false) {
  await page.goto("/account?view=signup");
  await page.getByLabel("Name", { exact: true }).fill("Test editor");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await submitAuth(page, "Create an account", "/api/auth/sign-up/email");
  await expect(page.getByRole("status")).toContainText("Check your inbox");
  expect((await page.request.get("/api/projects")).status()).toBe(401);
  if (checkUnverifiedLogin) {
    const unverified = await waitForQuota(() => page.request.post("/api/auth/sign-in/email", { data: { email, password, callbackURL: "/projects" } }));
    expect(unverified.status()).toBe(403);
  }
  await page.goto(await mailLink(page.request, email, "Verify your Cutroom email"));
  await expect(page.getByRole("heading", { name: "My projects" })).toBeVisible();
}
