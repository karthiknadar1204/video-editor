import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { projectSnapshot } from "../packages/timeline/src/model";
import { password, signIn, signup } from "./accounts";
import { webOrigin } from "./local";

test("a creator retries a phone upload, recovers a trimmed cut, adds a title and reopens it on a second device", async ({ page, browser }, info) => {
  const email = randomUUID() + "@cutroom.test";
  await signup(page, email);
  await page.getByRole("button", { name: "New project" }).click();
  const create = page.getByRole("dialog");
  await create.getByLabel("Project title").fill("Orbital study");
  await create.getByLabel("Canvas format").selectOption("portrait");
  await create.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name: "Orbital study" })).toBeVisible();
  const pathname = new URL(page.url()).pathname;
  const snapshot = async () => projectSnapshot.parse(await (await page.request.get("/api" + pathname)).json());
  const revision = (n: number) => expect(page.getByRole("status")).toContainText("Revision " + n);
  const fileName = "Camera take.mov";
  const phone = info.outputPath(fileName);
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-display_rotation:v:0", "90", "-i", "apps/web/public/media/earthrise-rushes.mp4",
    "-t", "2", "-c", "copy", phone]);

  await page.getByRole("button", { name: "Media library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Media library" });
  const transfer = process.env.E2E_LIVE_IMAGEKIT === "1" ? "https://upload.imagekit.io/api/v2/files/upload" : "**/assets/*/original";
  await page.route(transfer, route => route.abort("internetdisconnected"), { times: 1 });
  await library.getByLabel("Choose footage").setInputFiles(phone);
  await expect(library.getByText("The upload connection was interrupted.", { exact: false })).toBeVisible();
  expect((await snapshot()).revision).toBe(0);
  await library.getByRole("button", { name: "Retry upload" }).click();
  const item = library.getByRole("listitem").filter({ hasText: fileName });
  await expect(item).toContainText("540 × 960", { timeout:60_000 });
  await expect(item).toContainText("Playable · Transcript not started");
  await item.getByRole("button", { name: "Insert " + fileName }).click();
  await revision(2);
  const preview = page.getByRole("region", { name: "Project preview" });
  await expect.poll(() => preview.locator("video").first().evaluate((v: HTMLVideoElement) => [v.videoWidth, v.videoHeight])).toEqual([540, 960]);
  const inspector = page.getByRole("region", { name: "Clip inspector" });
  await inspector.getByLabel("Action").selectOption("right");
  await inspector.getByLabel("End frame (exclusive)").fill("30");

  // Disconnect after Postgres commits and before the response reaches the editor.
  const commands: string[] = [];
  await page.route("**/edits", async route => {
    commands.push(route.request().postData()!);
    if (commands.length === 1) {
      expect((await route.fetch()).ok()).toBe(true);
      await page.context().setOffline(true);
      await route.abort("internetdisconnected");
    } else await route.continue();
  });
  await inspector.getByRole("button", { name: "Apply edit" }).click();
  await expect(page.getByRole("button", { name: "Retry save" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export MP4" })).toBeDisabled();
  await page.context().setOffline(false);
  await page.reload();
  await page.getByRole("button", { name: "Retry save" }).click();
  await expect(page.getByRole("button", { name: "Retry save" })).toHaveCount(0);
  await revision(3);
  expect(commands).toHaveLength(2);
  expect(commands[0]).toBe(commands[1]);
  expect((await snapshot()).timeline.clips).toMatchObject([{ duration: 30 }]);

  const assistant = page.getByRole("region", { name: "Edit assistant" });
  const addTitle = assistant.getByRole("button", { name: /Add title/ });
  await addTitle.click();
  await assistant.getByRole("button", { name: "Stop", exact: true }).click();
  expect((await snapshot()).revision).toBe(3);
  await addTitle.click();
  await assistant.getByRole("button", { name: "Apply edit", exact: true }).click();
  await revision(4);
  await expect(preview.getByText("Orbital study", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("desktop-editor.png"), fullPage: true });

  const mobile = await browser.newContext({ baseURL: webOrigin, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const screen = await mobile.newPage();
    await signIn(screen, email, password);
    await screen.getByRole("link", { name: /Orbital study/ }).click();
    await expect(screen.getByRole("status")).toContainText("Revision 4");
    const monitor = screen.getByRole("region", { name: "Project preview" });
    await expect(monitor.getByText("Orbital study", { exact: true })).toBeVisible();
    await expect.poll(() => monitor.locator("video").first().evaluate((v: HTMLVideoElement) => [v.videoWidth, v.videoHeight])).toEqual([540, 960]);
    await screen.getByRole("button", { name: "Timeline", exact: true }).click();
    const take = screen.getByRole("group", { name: "video clips" }).getByRole("button").first();
    await take.click();
    await screen.getByRole("button", { name: "Assistant", exact: true }).click();
    await expect(screen.getByRole("region", { name: "Edit assistant" })).toContainText("Target · " + fileName);
    await expect(monitor).toBeVisible();
    expect(await screen.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await screen.screenshot({ path: info.outputPath("phone-editor.png"), fullPage: true });
  } finally { await mobile.close(); }
});
