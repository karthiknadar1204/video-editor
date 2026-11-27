import { randomUUID } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { devices, expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { mediaClip, rushes, textClip } from "../packages/timeline/src/model";
import { signup } from "./accounts";
import { testDatabase, webOrigin } from "./local";

async function setup(page: Page, title: string) {
  await signup(page, randomUUID() + "@cutroom.test");
  const r = await page.request.post("/api/projects", { data: { title, format: "portrait" } });
  const { id } = await r.json();
  const path = "/api/projects/" + id;
  const edit = (expectedRevision: number, operations: object[]) => page.request.post(path + "/edits", { data: {
    kind: "edit", requestId: randomUUID(), expectedRevision, operations,
  } });
  const start = async (revision: number) => {
    const response = await page.request.post(path + "/export", { headers: { Accept: "application/json" }, data: { revision } });
    await expect(response).toBeOK();
    return response.json();
  };
  const row = async (exportId: string) => (await page.request.get(path + "/exports/" + exportId)).json();
  return { id, path, edit, start, row };
}

test("two saved snapshots play with their own pixels and audio on a phone; revoking one preserves the other", async ({ page, browser }) => {
  test.setTimeout(210_000);
  const { path, edit, start, row } = await setup(page, "Portrait interview");
  await expect(await edit(0, [
    { type: "add", clip: { ...textClip("caption", "First caption", 0, 30, 1280), track: "caption", x: 40, y: 80, color: "#ff0011" } },
    { type: "add", clip: { ...mediaClip("dialogue", rushes.id, 0, 30), track: "speech", sourceStart: 60 } },
  ])).toBeOK();
  const first = await start(1);
  expect((await start(1)).id).toBe(first.id);
  await expect(await edit(1, [{ type: "text", id: "caption", text: "Second caption" },
    { type: "textStyle", id: "caption", fontSize: 76, color: "#00ff11" }])).toBeOK();
  const second = await start(2);
  expect(second.id).not.toBe(first.id);
  const watch = async (id: string) => {
    await expect.poll(async () => (await row(id)).status, { timeout: 90_000 }).toBe("completed");
    const res = await page.request.post(path + "/exports/" + id + "/share", { data: {} });
    await expect(res).toBeOK();
    return (await res.json()).watchPath as string;
  };
  const watchA = await watch(first.id), watchB = await watch(second.id);
  const guest = await browser.newContext({ ...devices["Pixel 7"], baseURL: webOrigin });
  try {
    const phone = await guest.newPage();
    for (const [index, link] of [watchA, watchB].entries()) {
      await phone.goto(link);
      await expect(phone.getByRole("heading", { name: "Portrait interview" })).toBeVisible();
      await expect(phone.getByText("Revision " + (index + 1), { exact: true })).toBeVisible();
      const media = "/api" + link + "/media";
      const range = await guest.request.get(media, { headers: { Range: "bytes=0-31" } });
      expect(range.status()).toBe(206);
      expect((await range.body()).length).toBe(32);
      expect(range.headers()["content-range"]).toMatch(/^bytes 0-31\//);
      const decoded = await phone.evaluate(async media => {
        const v = document.querySelector("video");
        if (!v) throw new Error("Missing video player.");
        if (v.readyState < 2) await new Promise<void>((resolve, reject) => { v.onloadeddata = () => resolve(); v.onerror = reject; });
        v.muted = true;
        await v.play();
        await new Promise<void>(resolve => v.requestVideoFrameCallback(() => resolve()));
        v.pause();
        await new Promise<void>((resolve, reject) => { v.onseeked = () => resolve(); v.onerror = reject; v.currentTime = .55; });
        const canvas = document.createElement("canvas");
        canvas.width = v.videoWidth; canvas.height = 255;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(v, 0, 0);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let red = 0, green = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] > 160 && pixels[i + 1] < 90) red++;
          if (pixels[i + 1] > 160 && pixels[i] < 90) green++;
        }
        const bytes = await (await fetch(media)).arrayBuffer();
        const pcm = await new OfflineAudioContext(1, 48_000, 48_000).decodeAudioData(bytes);
        const audio = pcm.getChannelData(0);
        const rms = Math.sqrt(audio.reduce((sum, n) => sum + n * n, 0) / audio.length);
        return { width: v.videoWidth, height: v.videoHeight, red, green, rms, horizontalOverflow: document.documentElement.scrollWidth > innerWidth };
      }, media);
      expect(decoded).toMatchObject({ width: 720, height: 1280, horizontalOverflow: false });
      expect(index ? decoded.green : decoded.red).toBeGreaterThan(300);
      expect(index ? decoded.red : decoded.green).toBeLessThan(50);
      expect(decoded.rms).toBeGreaterThan(.005);
      expect((await guest.request.get(path + "/exports/" + first.id + "/file")).status()).toBe(401);
    }
    await expect(await page.request.delete(path + "/exports/" + first.id + "/share")).toBeOK();
    await phone.goto(watchA);
    await expect(phone.getByRole("heading", { name: "This watch link is unavailable." })).toBeVisible();
    expect((await guest.request.get("/api" + watchA + "/media", { headers: { Range: "bytes=0-31" } })).status()).toBe(404);
    expect((await guest.request.get("/api" + watchB + "/media", { headers: { Range: "bytes=0-31" } })).status()).toBe(206);
    await expect(await page.request.delete(path + "/exports/" + second.id + "/share")).toBeOK();
  } finally {
    await guest.close();
    if (process.env.E2E_LIVE_IMAGEKIT === "1") {
      const sql = postgres(testDatabase, { max: 1 });
      try {
        await sql`UPDATE export_version SET expires_at=now() - interval '1 minute' WHERE id IN (${first.id},${second.id})`;
        await expect.poll(async () => (await sql`SELECT id FROM export_version WHERE id IN (${first.id},${second.id})`).length,
          { timeout: 90_000, intervals: [1000, 2500] }).toBe(0);
      } finally { await sql.end(); }
    }
  }
});

test("cancellation, worker recovery and repeated admission preserve the original snapshot and attempt outcomes", async ({ page }) => {
  const { id, path, start, row, edit } = await setup(page, "Interrupted publish");
  await expect(await edit(0, [{ type: "add", clip: textClip("title", "First cut", 0, 45, 1280) }])).toBeOK();
  const initial = await start(1), endpoint = path + "/exports/" + initial.id;
  const cancelled = await page.request.delete(endpoint + "?attempt=1");
  expect((await cancelled.json()).status).toBe("cancelled");
  expect((await page.request.get(endpoint + "/file")).status()).toBe(404);
  await page.goto("/projects/" + id);
  await page.getByRole("button", { name: "Export history" }).click();
  await expect(page.getByRole("dialog", { name: "Export history" }).getByText("Cancelled", { exact: true })).toBeVisible();
  await expect(await edit(1, [{ type: "text", id: "title", text: "A later edit" }])).toBeOK();
  const sql = postgres(testDatabase, { max: 1 });
  try {
    // An uploader died after acquiring its lease and before publishing a downloadable version.
    await sql.begin(async tx => {
      await tx`INSERT INTO export_attempt(export_id,number,status,claim,lease_until) VALUES
        (${initial.id},2,'uploading',${randomUUID()},now() - interval '1 minute')`;
      await tx`UPDATE export_version SET attempt=2 WHERE id=${initial.id}`;
    });
    expect((await start(1)).id).toBe(initial.id);
    await expect.poll(async () => (await row(initial.id)).status, { timeout: 90_000 }).toBe("completed");
    const attempts = await sql`SELECT number,status FROM export_attempt WHERE export_id=${initial.id} ORDER BY number`;
    expect(attempts.map(a => [a.number,a.status])).toEqual([[1,"cancelled"],[2,"failed"],[3,"completed"]]);
    const staleCancel = await page.request.delete(endpoint + "?attempt=1");
    expect(await staleCancel.json()).toMatchObject({ status: "completed", revision: 1, attempt: 3 });
    expect((await page.request.get(endpoint + "/file")).status()).toBe(200);
  } finally { await sql.end(); }
});

test("a missing original names the source; retry restores the pinned version once after a new edit", async ({ page }) => {
  test.skip(process.env.E2E_LIVE_IMAGEKIT === "1", "Exercises failure by temporarily moving only this local test upload.");
  const { id, path, edit, row, start } = await setup(page, "Missing source");
  const bytes = await readFile("apps/web/public/media/earthrise.mp4");
  const reserve = await page.request.post(path + "/assets", { data: { name: "Interview camera.mp4", size: bytes.length, type: "video/mp4" } });
  const asset = await reserve.json();
  await expect(await page.request.put(asset.upload.url, { data: bytes })).toBeOK();
  await expect(await page.request.post(path + "/assets/" + asset.id, { data: {} })).toBeOK();
  await expect(await edit(1, [{ type: "add", clip: mediaClip("camera", asset.id, 0, 20) }])).toBeOK();
  const original = join(".local/media-test", id, asset.id, "original.mp4");
  await rename(original, original + ".unavailable");
  let version: { id: string };
  try {
    version = await start(2);
    await expect.poll(async () => (await row(version.id)).status, { timeout: 45_000 }).toBe("failed");
    expect((await row(version.id)).error).toContain("Interview camera.mp4");
  } finally { await rename(original + ".unavailable", original); }
  await expect(await edit(2, [{ type: "move", id: "camera", start: 2 }])).toBeOK();
  const retry = () => page.request.post(path + "/exports/" + version.id + "/retry", { data: { attempt: 1 } });
  const responses = await Promise.all([retry(), retry()]);
  for (const res of responses) expect(await res.json()).toMatchObject({ id: version.id, revision: 2, attempt: 2 });
  await expect.poll(async () => (await row(version.id)).status, { timeout: 90_000 }).toBe("completed");
  const history = await (await page.request.get(path + "/exports")).json();
  expect(history.items).toHaveLength(1);
});
