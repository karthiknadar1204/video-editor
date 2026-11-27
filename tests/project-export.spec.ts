import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { mediaClip, projectSnapshot, textClip } from "../packages/timeline/src/model";
import { signup } from "./accounts";
import { webOrigin } from "./local";

test("export downloads the saved portrait edit with private source media and rejects a different owner", async ({ page, browser }) => {
  await signup(page, randomUUID() + "@cutroom.test");
  const create = await page.request.post("/api/projects", { data: { title: "Orbit portrait", format: "portrait" } });
  expect(create.status()).toBe(201);
  const { id } = await create.json();
  const path = "/api/projects/" + id;
  const bytes = await readFile("apps/web/public/media/earthrise.mp4");
  await page.goto("/projects/" + id);
  await page.getByRole("button", { name: "Add footage" }).click();
  const library = page.getByRole("dialog", { name: "Media library" });
  await library.getByLabel("Choose footage").setInputFiles({ name:"Orbit footage.mp4", mimeType:"video/mp4", buffer:bytes });
  await expect(library.getByRole("button", { name:"Insert Orbit footage.mp4" })).toBeVisible({ timeout:60_000 });
  await library.getByRole("button", { name: "Close media library" }).click();
  const project = projectSnapshot.parse(await (await page.request.get(path)).json());
  const asset = project.timeline.assets.find(a => a.name === "Orbit footage.mp4");
  if (!asset) throw new Error("Uploaded footage is missing from the project.");
  const saved = await page.request.post(path + "/edits", { data: { kind: "edit", expectedRevision: 1, requestId: randomUUID(), operations: [
    { type: "add", clip: { ...mediaClip("camera", asset.id, 0, 30), fit: "contain" } },
    { type: "add", clip: { ...textClip("title", "LUNAR", 0, 30, 1280), x: 30, y: 40, color: "#ff3020" } },
  ] } });
  expect(saved.status()).toBe(200);
  expect((await page.request.post(path + "/export", { data: { revision: 1 } })).status()).toBe(409);
  await page.goto("/projects/" + id);
  const started = page.waitForResponse(r => r.url().endsWith(path + "/export") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Export MP4" }).click();
  expect((await started).status()).toBe(200);
  const changed = await page.request.post(path + "/edits", { data: { kind: "edit", expectedRevision: 2, requestId: randomUUID(), operations: [
    { type: "position", id: "title", x: 2000, y: 40 },
  ] } });
  expect(changed.status()).toBe(200);
  const download = page.getByRole("link", { name: /Download (MP4|revision 2)/ });
  await expect(download).toBeVisible({ timeout: 90_000 });
  await expect(download).toHaveAttribute("href", path + "/export?revision=2");
  expect((await page.request.get(path + "/export?revision=3")).status()).toBe(404);
  const [file] = await Promise.all([page.waitForEvent("download"), download.click()]);
  expect(file.suggestedFilename()).toBe("Orbit portrait.mp4");
  expect(await file.failure()).toBeNull();
  const result = await page.evaluate(async url => {
    const payload = await (await fetch(url)).blob();
    const video = document.createElement("video");
    video.muted = true;
    video.src = URL.createObjectURL(payload);
    try {
      await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = reject; });
      await video.play();
      await new Promise(resolve => video.requestVideoFrameCallback(resolve));
      video.pause();
      await new Promise((resolve, reject) => {
        video.onseeked = resolve; video.onerror = reject; video.currentTime = 0.5;
      });
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(video, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let red = 0, litSource = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (i < canvas.width * 150 * 4 && pixels[i] > 150 && pixels[i + 1] < 90 && pixels[i + 2] < 90) red++;
        if (i > canvas.width * 450 * 4 && i < canvas.width * 840 * 4 && pixels[i + 2] > 100) litSource++;
      }
      return { width: video.videoWidth, height: video.videoHeight, duration: video.duration, red, litSource };
    } finally { URL.revokeObjectURL(video.src); }
  }, path + "/export?revision=2");
  expect(result).toMatchObject({ width: 720, height: 1280 });
  expect(result.duration).toBeCloseTo(1, 1);
  expect(result.red).toBeGreaterThan(100);
  expect(result.litSource).toBeGreaterThan(500);

  const other = await browser.newContext({ baseURL: webOrigin });
  try {
    await signup(await other.newPage(), randomUUID() + "@cutroom.test");
    expect((await other.request.get(path + "/export?revision=2")).status()).toBe(404);
    expect((await other.request.post(path + "/export", { data: { revision: 2 } })).status()).toBe(404);
  } finally { await other.close(); }
});
