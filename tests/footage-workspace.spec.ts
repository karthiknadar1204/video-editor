import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { projectSnapshot } from "../packages/timeline/src/model";
import { signup } from "./accounts";
import { webOrigin } from "./local";

test("a creator inspects silent footage, finds imported subtitles on the timeline, and keeps the original after a correction", async ({ page, browser, request }, info) => {
  const name = "Colour study.mp4";
  const file = info.outputPath(name);
  execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "color=blue:s=160x90:r=30:d=1",
    "-f", "lavfi", "-i", "color=lime:s=160x90:r=30:d=1", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
    "-map", "[v]", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
  await signup(page, randomUUID() + "@cutroom.test");
  const create = await page.request.post("/api/projects", { data: { title: "Colour rushes", format: "landscape" } });
  await expect(create).toBeOK();
  const { id } = await create.json();
  const project = "/api/projects/" + id;
  await page.goto("/projects/" + id);
  await page.getByRole("button", { name: "Add footage" }).click();
  const library = page.getByRole("dialog", { name: "Media library" });
  await library.getByLabel("Choose footage").setInputFiles(file);
  const insert = library.getByRole("button", { name: "Insert " + name });
  await expect(insert).toBeVisible({ timeout: 60_000 });
  await insert.click();
  await expect(page.getByRole("status")).toContainText("Revision 2");
  const snapshot = projectSnapshot.parse(await (await page.request.get(project)).json());
  const asset = snapshot.timeline.assets.find(item => item.name === name);
  if (!asset) throw new Error("Silent upload missing.");
  const analysis = project + "/assets/" + asset.id + "/analysis";
  const read = async (view = "active") => {
    const response = await page.request.get(analysis, { params: { view } });
    await expect(response).toBeOK();
    return response.json();
  };
  const open = async () => {
    await page.getByRole("button", { name: "Media library", exact: true }).click();
    await page.getByRole("button", { name: "Inspect " + name, exact: true }).click();
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  };
  await open();
  await expect.poll(read, { timeout: 60_000 }).toMatchObject({ status: "ready", hasAudio: false, transcriptStatus: "no-speech", total: 0 });
  await expect(page.getByText("No speech detected", { exact: true })).toBeVisible({ timeout: 30_000 });
  const sheet = page.getByRole("img", { name: "Source contact sheet" });
  await expect(sheet).toBeVisible({ timeout: 30_000 });
  const colours = await sheet.evaluate(async (img: HTMLImageElement) => {
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let blue = 0, green = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 2] > 180 && pixels[i + 1] < 80) blue++;
      if (pixels[i + 1] > 180 && pixels[i + 2] < 80) green++;
    }
    return { blue, green };
  });
  expect(colours.blue).toBeGreaterThan(100);
  expect(colours.green).toBeGreaterThan(100);
  const before = await read();
  const retries = await Promise.all([1, 2].map(() => page.request.post(analysis, { data: {} })));
  for (const response of retries) await expect(response).toBeOK();
  expect(await read()).toEqual(before);
  const input = "1\n00:00:00,500 --> 00:00:01,500\nAmber eclipse\n";
  await page.getByLabel("Import subtitles").setInputFiles({ name: "colour.srt", mimeType: "text/plain", buffer: Buffer.from(input) });
  await expect.poll(read).toMatchObject({ transcriptStatus: "imported", revision: 1, total: 2 });
  await page.getByLabel("Find a phrase").fill("amber eclipse");
  await page.getByRole("button", { name: "Search transcript" }).click();
  await page.getByRole("button", { name: /Show .* on timeline/i }).click();
  await expect(page.getByLabel("Playhead frame")).toHaveValue("15");
  await expect(page.getByRole("button", { name: name + " at frame 0" })).toHaveAttribute("aria-pressed", "true");

  await open();
  await page.getByRole("button", { name: "Edit word 2", exact: true }).click();
  await expect(page.getByLabel("Start (ms)", { exact: true })).toHaveValue("1000");
  await expect(page.getByLabel("End (ms)", { exact: true })).toHaveValue("1500");
  await expect.poll(() => page.getByLabel("Original source playback").evaluate((video: HTMLVideoElement) => video.currentTime)).toBeCloseTo(1, 1);
  await page.getByLabel("Word", { exact: true }).fill("sunrise");
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect.poll(read).toMatchObject({ transcriptStatus: "corrected", revision: 2, words: [
    { text: "Amber" }, { text: "sunrise", startMs: 1000, endMs: 1500, timing: "estimated" },
  ] });
  await page.reload();
  await open();
  const version = page.getByLabel("Transcript version");
  await version.selectOption({ label: "Imported subtitles" });
  await expect(page.getByText("eclipse", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit word 2", exact: true }).click();
  await expect(page.getByLabel("Word", { exact: true })).toBeDisabled();
  await version.selectOption({ label: "Current transcript" });
  await expect(page.getByText("sunrise", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit word 2", exact: true }).click();
  await page.getByRole("checkbox", { name: "I reviewed both boundaries" }).check();
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect.poll(read).toMatchObject({ revision: 3, words: [
    { text: "Amber", timing: "estimated" }, { text: "sunrise", startMs: 1000, endMs: 1500, timing: "corrected" },
  ] });
  await page.getByLabel("Search by").selectOption({ label: "Source time" });
  await page.getByLabel("From (seconds)").fill("1.1");
  await page.getByLabel("To (seconds)").fill("1.4");
  await page.getByRole("button", { name: "Search transcript" }).click();
  const placement = page.getByRole("button", { name: "Show video at frame 30 on timeline" });
  await expect(placement).toBeVisible();
  await expect(page.getByText("Source 1.00 s–1.50 s · Reviewed", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("source-inspector.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(placement).toBeVisible();
  const widths = await library.evaluate(dialog => ({
    viewport: window.innerWidth, page: document.documentElement.scrollWidth, visible: dialog.clientWidth, content: dialog.scrollWidth,
  }));
  expect(widths.page).toBeLessThanOrEqual(widths.viewport);
  expect(widths.content).toBeLessThanOrEqual(widths.visible + 1);
  await page.screenshot({ path: info.outputPath("source-inspector-phone.png") });
  await placement.click();
  await expect(page.getByLabel("Playhead frame")).toHaveValue("30");

  const writes = ["Copper", "Gold"];
  const competing = await Promise.all(writes.map(text => page.request.put(analysis, { data: { revision: 3, index: 0, correction: { text } } })));
  expect(competing.map(result => result.status()).sort()).toEqual([204, 409]);
  const winner = writes[competing.findIndex(result => result.ok())];
  expect(await read()).toMatchObject({ revision: 4, words: [{ text: winner }, { text: "sunrise", timing: "corrected" }] });
  expect(await read("imported")).toMatchObject({ total: 2, words: [{ text: "Amber" }, { text: "eclipse" }] });
  expect(await read("original")).toMatchObject({ total: 0, words: [] });
  expect((await (await page.request.get(project)).json()).revision).toBe(snapshot.revision);
  expect((await request.get(analysis + "/sheet")).status()).toBe(401);
  const other = await browser.newContext({ baseURL: webOrigin });
  try {
    await signup(await other.newPage(), randomUUID() + "@cutroom.test");
    expect((await other.request.get(analysis)).status()).toBe(404);
    expect((await other.request.put(analysis, { data: { revision: 4, index: 0, correction: { text: "Other" } } })).status()).toBe(404);
    expect((await other.request.get(analysis + "/sheet")).status()).toBe(404);
  } finally { await other.close(); }
});
