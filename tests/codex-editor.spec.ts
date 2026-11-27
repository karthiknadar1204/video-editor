import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { projectSnapshot, textClip } from "../packages/timeline/src/model";
import { signup } from "./accounts";
import { webOrigin } from "./local";
import { runExternalCodex } from "./fixtures/external-codex";

async function setup(page: Page) {
  await signup(page, randomUUID() + "@cutroom.test");
  const created = await page.request.post("/api/projects", {
    data: { title: "Interview selects", format: "landscape" },
  });
  const path = "/projects/" + (await created.json()).id;
  const operations = ["Opening", "Closing"].map((name, i) => ({
    type: "add",
    clip: textClip(name.toLowerCase(), name, i * 30, 30, 720),
  }));
  expect(
    (
      await page.request.post("/api" + path + "/edits", {
        data: { kind: "edit", expectedRevision: 0, requestId: randomUUID(), operations },
      })
    ).status(),
  ).toBe(200);
  await page.goto(path);
  return {
    path,
    snapshot: async () => projectSnapshot.parse(await (await page.request.get("/api" + path)).json()),
  };
}

test("Codex edits the selected title, sees the saved frame and reattaches after refresh; Undo restores the original", async ({
  page,
}) => {
  test.setTimeout(210_000);
  const { snapshot } = await setup(page);
  const observed = async () =>
    (await (await page.request.get("http://127.0.0.1:4202/observations")).json()).nativeImages as number;
  const beforeImages = process.env.E2E_LIVE_CODEX === "1" ? null : await observed();
  const chat = page.getByRole("region", { name: "Edit assistant" });
  await page.getByRole("button", { name: "Closing at frame 30" }).click();
  await chat.getByRole("textbox", { name: "Ask Codex" }).fill("Change this to Behind the scenes.");
  await chat.getByRole("button", { name: "Send to Codex" }).click();
  await expect(chat.getByRole("button", { name: "Stop Codex" })).toBeVisible();
  await page.reload();
  await expect(chat.getByText("Change this to Behind the scenes.", { exact: true })).toBeVisible();
  await expect(chat.getByText("Saved revision 2", { exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(chat.getByRole("button", { name: "Stop Codex" })).toHaveCount(0, { timeout: 100_000 });
  expect((await snapshot()).timeline.clips).toMatchObject([
    { id: "opening", text: "Opening" },
    { id: "closing", text: "Behind the scenes" },
  ]);
  await expect(chat.getByRole("list", { name: "Activity" })).toContainText(/Frame \d+ at revision 2 · ready/i);
  await expect(chat.getByRole("list", { name: "Activity" })).toContainText("Model received the rendered frame");
  if (beforeImages !== null) expect(await observed()).toBeGreaterThan(beforeImages);
  await page.reload();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Revision 3");
  expect((await snapshot()).timeline.clips).toMatchObject([
    { id: "opening", text: "Opening" },
    { id: "closing", text: "Closing" },
  ]);
});

test("Stop interrupts an in-flight Codex request before it can write a title", async ({ page }) => {
  test.skip(process.env.E2E_LIVE_CODEX === "1", "Uses a deliberately delayed model response.");
  const { path, snapshot } = await setup(page);
  const held = async () => (await (await page.request.get("http://127.0.0.1:4202/observations")).json()).held;
  const before = await held();
  await page.getByRole("button", { name: "Closing at frame 30" }).click();
  const chat = page.getByRole("region", { name: "Edit assistant" });
  await chat
    .getByRole("textbox", { name: "Ask Codex" })
    .fill("Change this to Behind the scenes. Hold before edit.");
  const sent = page.waitForRequest((r) => r.url().endsWith(path + "/runs") && r.method() === "POST");
  await chat.getByRole("button", { name: "Send to Codex" }).click();
  const command = (await sent).postDataJSON();
  await expect.poll(held, { timeout: 40_000 }).toBeGreaterThan(before);
  await chat.getByRole("button", { name: "Stop Codex" }).click();
  await expect(chat.getByText(/Stopped\. Any edit already saved/)).toBeVisible();
  await page.reload();
  await expect(chat.getByText(/Stopped\. Any edit already saved/)).toBeVisible();
  expect((await snapshot()).revision).toBe(1);
  expect((await page.request.post("/api" + path + "/runs", { data: command })).status()).toBe(200);
  expect(
    (await page.request.post("/api" + path + "/runs", { data: { ...command, id: randomUUID() } })).status(),
  ).toBe(429);
});

test("external Codex uses a one-time project key, edits an explicit title, then loses access on revocation", async ({
  page,
}) => {
  test.setTimeout(210_000);
  const { path, snapshot } = await setup(page);
  await page.getByRole("button", { name: "Connect Codex", exact: true }).click();
  const box = page.getByRole("dialog", { name: "Connect Codex" });
  await box.getByRole("button", { name: "Create project key" }).click();
  const token = await box.getByRole("textbox", { name: /Project key/ }).inputValue();
  await box.getByRole("button", { name: "Close connection" }).click();
  const reply = await runExternalCodex({
    mcpUrl: webOrigin + "/api/mcp",
    token,
    prompt:
      "In this project change title clip closing to Behind the scenes. Its timeline start is frame 30. Inspect the updated frame and confirm the change.",
  });
  if (process.env.E2E_LIVE_CODEX !== "1") expect(reply).toContain("inspected the saved frame");
  expect((await snapshot()).timeline.clips).toMatchObject([
    { id: "opening", text: "Opening" },
    { id: "closing", text: "Behind the scenes" },
  ]);
  await page.getByRole("button", { name: "Connect Codex", exact: true }).click();
  await expect(box.getByText(/Last connected/)).toBeVisible();
  await expect(box.getByRole("textbox", { name: /Project key/ })).toHaveCount(0);
  await box.getByRole("button", { name: "Revoke project key" }).click();
  await expect(box.getByText("Project key revoked.")).toBeVisible();
  const denied = await page.request.post("/api/mcp", {
    headers: { Authorization: "Bearer " + token, Accept: "application/json, text/event-stream" },
    data: { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "read_project", arguments: {} } },
  });
  expect(denied.status()).toBe(401);
  await box.getByRole("button", { name: "Close connection" }).click();
  await page.goto(path);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Revision 3");
});

test("an exhausted model budget shows a billing message and leaves manual editing available", async ({page}) => {
  test.skip(process.env.E2E_LIVE_CODEX === "1", "Specifically checks a simulated provider billing error.");
  const {snapshot} = await setup(page);
  await page.getByRole("button", {name:"Closing at frame 30"}).click();
  const chat = page.getByRole("region", {name:"Edit assistant"});
  await chat.getByRole("textbox", {name:"Ask Codex"}).fill("simulate credit_balance_exhausted");
  await chat.getByRole("button", {name:"Send to Codex"}).click();
  await expect(chat.getByText(/OpenAI API project has no available credits/)).toBeVisible({timeout:30_000});
  expect((await snapshot()).revision).toBe(1);
  const inspector = page.getByRole("region", {name:"Clip inspector"});
  await inspector.getByLabel("Clip text").fill("Manual title");
  await inspector.getByRole("button", {name:"Save properties"}).click();
  await expect(page.getByRole("status")).toContainText("Revision 2");
});
