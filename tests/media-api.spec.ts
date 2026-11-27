import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { signup } from "./accounts";

test("private phone footage is verified, oriented, seekable and attached once; unfinished uploads stay private", async ({ page, browser }, info) => {
  await signup(page, randomUUID() + "@cutroom.test");
  const created = await page.request.post("/api/projects", { data: { title: "Phone rushes", format: "portrait" } });
  expect(created.status()).toBe(201);
  const project = "/api/projects/" + (await created.json()).id;
  const assets = project + "/assets";
  const path = info.outputPath("phone.mov");
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-display_rotation:v:0", "90", "-i", "apps/web/public/media/earthrise-rushes.mp4",
    "-t", "1", "-c", "copy", path]);
  const bytes = await readFile(path);
  const reserve = () => page.request.post(assets, { data: { name: "Camera take.mov", type: "video/quicktime", size: bytes.length } });
  const response = await reserve();
  expect(response.status()).toBe(201);
  const { id, upload } = await response.json();
  const asset = assets + "/" + id;
  expect(upload.method).toBe("PUT");
  expect((await page.request.get(asset + "/original")).status()).toBe(404);
  expect((await page.request.put(upload.url, { data: bytes })).status()).toBe(204);
  const finished = await page.request.post(asset, { data: {} });
  expect(finished.status(), await finished.text()).toBe(200);
  const media = await finished.json();
  expect(media).toMatchObject({ id, name: "Camera take.mov", src: asset + "/playback",
    metadata: { mediaType: "video", height: 960, width: 540, hasAudio: true, size: bytes.length, transcript: "not-started" } });
  expect(Math.abs(media.metadata.rotation)).toBe(90);
  expect(media.metadata.audio).toMatchObject({ codec: "aac", channels: expect.any(Number), sampleRate: expect.any(Number) });
  expect(media.duration).toBeGreaterThanOrEqual(30);
  expect((await page.request.post(asset, { data: {} })).status()).toBe(200);
  const reopened = await (await page.request.get(project)).json();
  expect(reopened.revision).toBe(1);
  expect(reopened.timeline.assets.filter((a: { id: string }) => a.id === id)).toHaveLength(1);
  expect((await page.request.get(media.metadata.thumbnail)).headers()["content-type"]).toBe("image/jpeg");
  const segment = await page.request.get(asset + "/original", { headers: { Range: "bytes=0-15" } });
  expect(segment.status()).toBe(206);
  expect(await segment.body()).toEqual(bytes.subarray(0, 16));
  const display = await page.evaluate(async url => {
    const video = document.createElement("video");
    video.src = url;
    await new Promise<void>((resolve, reject) => { video.onloadedmetadata = () => resolve(); video.onerror = () => reject(Error("Video metadata failed")); });
    video.currentTime = 0.5;
    await new Promise<void>((resolve, reject) => { video.onseeked = () => resolve(); video.onerror = () => reject(Error("Seek failed")); });
    return [video.videoWidth, video.videoHeight, video.currentTime];
  }, media.src);
  expect(display).toEqual([540, 960, 0.5]);
  const other = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    await signup(await other.newPage(), randomUUID() + "@cutroom.test");
    for (const kind of ["original", "thumbnail", "playback"]) expect((await other.request.get(asset + "/" + kind)).status()).toBe(404);
    expect((await other.request.post(asset, { data: {} })).status()).toBe(404);
  } finally { await other.close(); }
  const rejected = await page.request.post(assets, { data: { name: "notes.txt", type: "text/plain", size: 4 } });
  expect(rejected.status()).toBe(415);
  const invalid = await page.request.post(assets, { data: { name: "broken.mov", type: "video/quicktime", size: 4 } });
  const broken = await invalid.json();
  expect((await page.request.put(broken.upload.url, { data: Buffer.from("oops") })).status()).toBe(204);
  expect((await page.request.post(assets + "/" + broken.id, { data: {} })).status()).toBe(422);
  expect((await page.request.delete(assets + "/" + broken.id)).status()).toBe(204);
  expect((await page.request.post(assets + "/" + broken.id, { data: {} })).status()).toBe(404);
  expect((await page.request.get(assets + "/" + broken.id + "/original")).status()).toBe(404);
});
