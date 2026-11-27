import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { signup } from "./accounts";

test("ImageKit accepts a bound browser upload and serves the private, processed recording", async ({ page }, info) => {
  test.skip(process.env.E2E_LIVE_IMAGEKIT !== "1", "Requires a configured ImageKit account.");
  await signup(page, randomUUID() + "@cutroom.test");
  const created = await page.request.post("/api/projects", { data: { title: "ImageKit verification", format: "portrait" } });
  const base = "/api/projects/" + (await created.json()).id + "/assets";
  const file = info.outputPath("portrait.mp4");
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=90x160:rate=30",
    "-t", "0.6", "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
  const bytes = await readFile(file);
  const grant = await page.request.post(base, { data: { name: "Portrait test.mp4", type: "video/mp4", size: bytes.length } });
  expect(grant.status()).toBe(201);
  const { id, upload } = await grant.json();
  expect(upload.method).toBe("POST");
  const direct = await page.evaluate(async ({ bytes, upload }) => {
    const form = new FormData();
    for (const [key, value] of Object.entries<string>(upload.fields)) form.append(key, value);
    form.append("file", new File([Uint8Array.from(bytes)], "portrait.mp4", { type: "video/mp4" }));
    const result = await fetch(upload.url, { method: "POST", body: form });
    const body = await result.json();
    return { status: result.status, fileId: body.fileId, reason: String(body.message ?? "").slice(0, 250) };
  }, { bytes: [...bytes], upload });
  expect(direct.status, direct.reason.replace(/[A-Za-z0-9_.-]{30,}/g, "[redacted]")).toBe(200);
  const attached = await page.request.post(base + "/" + id, { data: { fileId: direct.fileId } });
  expect(attached.status(), attached.ok() ? "" : await attached.text()).toBe(200);
  const media = await attached.json();
  expect(media.metadata).toMatchObject({ width: 90, height: 160, hasAudio: false, transcript: "unavailable", mediaType: "video" });
  expect((await page.request.get(media.metadata.thumbnail)).headers()["content-type"]).toContain("image/");
  const original = await page.request.get(base + "/" + id + "/original");
  expect(original.ok()).toBe(true);
  expect(Buffer.compare(await original.body(), bytes)).toBe(0);
  const display = await page.evaluate(async src => {
    const video = document.createElement("video");
    video.src = src;
    await new Promise<void>((resolve, reject) => { video.onloadeddata = () => resolve(); video.onerror = () => reject(Error("Playback failed")); });
    return [video.videoWidth, video.videoHeight];
  }, media.src);
  expect(display).toEqual([90, 160]);
});
