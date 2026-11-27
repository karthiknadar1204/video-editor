import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mediaClip, projectSnapshot, roughCutReceiptSchema } from "../packages/timeline/src";
import { signup } from "./accounts";
import { runExternalCodex } from "./fixtures/external-codex";
import { webOrigin } from "./local";

const prompt =
  'Make a rough cut of clip interview. Remove long pauses and clear duplicate takes, but keep "you got a color film jim" every time. Use highlighted captions. First preview them at the top, then move them to the bottom and inspect the updated candidate. Commit that cut and inspect the saved frame.';

const measure = process.env.E2E_RELEASE_METRICS === "1";
const elapsed = (start: number) => Math.round(performance.now() - start);

type FixtureWord = { text: string; startMs: number; endMs: number };
type TranscriptWrite = { revision: number } & ({ subtitles: string } | { index: number; correction: Omit<FixtureWord, "text"> });
async function saveTranscript(page: Page, endpoint: string, write: TranscriptWrite, words: FixtureWord[]) {
  let reading = false, conflict = false;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const request = reading ? page.request.get(endpoint) : page.request.put(endpoint, { data: write });
    const response = await request.catch((error: unknown) => {
      const first = error instanceof Error ? error.message.split("\n", 1)[0] : "";
      if (/ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|socket hang up|request timed out|timeout .*exceeded/i.test(first)) return null;
      throw new Error("Fixture transcript request failed in the client.");
    });
    const status = response?.status() ?? 0;
    if (!reading && status === 204) return;
    const body = await response?.json().catch(() => null);
    if (reading && status === 200) {
      const rev = body?.revision;
      if (rev !== write.revision && rev !== write.revision + 1) throw new Error("Fixture transcript revision changed.");
      const expected = words.map((w, i) => ({ ...w, timing: i < rev - 1 ? "corrected" : "estimated" }));
      if (rev > 0 && !(body.hasImport && body.total === words.length && isDeepStrictEqual(body.words, expected))) {
        throw new Error("Fixture transcript content changed.");
      }
      if (rev === write.revision + 1) return;
      if (conflict) throw new Error("Fixture transcript write conflicted.");
      reading = false;
      continue;
    }
    const codes = ["database_connection", "transaction_contention", "database_constraint", "analysis_unexpected"];
    const code = codes.includes(body?.code) ? String(body.code) : "http";
    if (!reading && status === 409) conflict = true;
    else if (![0, 408, 502, 504].includes(status) &&
        !(status === 503 && (!body?.code || ["database_connection", "transaction_contention"].includes(code)))) {
      throw new Error("Fixture transcript request failed (" + status + ", " + code + ").");
    }
    console.info("Checking fixture transcript after request", status, code);
    reading = true;
    await delay(150 * attempt);
  }
  throw new Error("Fixture transcript recovery budget exhausted.");
}

async function observeNativeTranscript(page: Page, endpoint: string, uploadAt: number) {
  while (elapsed(uploadAt) < 90_000) {
    const response = await page.request.get(endpoint + "?view=original", { timeout: 5000 });
    if (!response.ok()) return null;
    const analysis = await response.json();
    if (analysis.hasOriginal && analysis.total > 0) return elapsed(uploadAt);
    if (analysis.status === "ready" || analysis.status === "failed") return null;
    await delay(350);
  }
  return null;
}

async function measureFrame(page: Page, base: string, revision: number, frame: number) {
  const connection = await page.request.post(base + "/connection", { data: {} });
  if (!connection.ok()) return null;
  const { key } = await connection.json();
  const start = performance.now();
  try {
    while (elapsed(start) < 35_000) {
      const response = await page.request.post("/api/mcp", {
        headers: { Authorization: "Bearer " + key, Accept: "application/json, text/event-stream" },
        data: { jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name: "render_frame", arguments: { revision, frame } } },
        timeout: 15_000,
      });
      if (!response.ok()) return null;
      const { result } = await response.json();
      if (!result || result.isError) return null;
      if (result.content.some((c: { type: string; data?: string }) => c.type === "image" && c.data)) return elapsed(start);
      await delay(250);
    }
    return null;
  } finally {
    await page.request.delete(base + "/connection");
  }
}

async function observeExport(page: Page, base: string, revision: number, start: number, signal: AbortSignal) {
  let queued: number | null = null, active: number | null = null, completed: number | null = null;
  while (!signal.aborted && elapsed(start) < 150_000) {
    const response = await page.request.get(base + "/exports", { timeout: 5000 });
    if (!response.ok()) break;
    const { items } = await response.json();
    const job = items.find((item: { revision: number }) => item.revision === revision);
    const now = elapsed(start);
    if (job?.status === "queued") queued ??= now;
    if (job?.status === "rendering" || job?.status === "uploading") active ??= now;
    if (job?.status === "completed") { completed = now; break; }
    if (job?.status === "failed" || job?.status === "cancelled") break;
    await delay(200);
  }
  return {
    observedExportQueueMs: queued !== null && active !== null ? active - queued : null,
    submitToObservedActiveExportMs: active,
    observedActiveExportThroughUploadMs: active !== null && completed !== null ? completed - active : null,
  };
}

async function prepare(page: Page, info: TestInfo) {
  const path = info.outputPath("interview-takes.mp4");
  // Two real takes of each Apollo 8 excerpt, with a deliberate 1.4s silence between the passages.
  const fixture = "apps/web/public/media/earthrise.mp4";
  const pcm = execFileSync(
    "ffmpeg",
    ["-nostdin", "-v", "error", "-i", fixture, "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"],
    { timeout: 30_000 },
  );
  const part = (fromMs: number, toMs: number) => pcm.subarray(fromMs * 32, toMs * 32);
  const first = part(860, 2560),
    second = part(8000, 10000);
  const voice = Buffer.concat([first, first, Buffer.alloc(1400 * 32), second, second]);
  execFileSync(
    "ffmpeg",
    [
      "-nostdin",
      "-v",
      "error",
      "-i",
      fixture,
      "-f",
      "s16le",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-i",
      "pipe:0",
      "-map",
      "0:v:0",
      "-map",
      "1:a",
      "-vf",
      "scale=320:180",
      "-t",
      "8.8",
      "-threads",
      "1",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-c:a",
      "aac",
      path,
    ],
    { input: voice, timeout: 30_000 },
  );
  await signup(page, randomUUID() + "@cutroom.test");
  const create = await page.request.post("/api/projects", {
    data: { title: "Apollo interview review", format: "landscape" },
  });
  expect(create.status(), "Fixture project creation").toBe(201);
  const { id } = await create.json(),
    base = "/api/projects/" + id,
    editor = "/projects/" + id;
  const read = async () => projectSnapshot.parse(await (await page.request.get(base)).json());
  await page.goto(editor);
  await page.getByRole("button", { name: "Media library", exact: true }).click();
  const uploadAt = performance.now();
  await page.getByLabel("Choose footage").setInputFiles(path);
  await expect(page.getByRole("button", { name: "Insert interview-takes.mp4" })).toBeVisible({ timeout: 90_000 });
  const uploadToPlayableMs = Math.round(performance.now() - uploadAt);
  const original = await read();
  const source = original.timeline.assets.find((a) => a.name === "interview-takes.mp4");
  if (!source) throw new Error("Fixture footage is missing.");
  const endpoint = base + "/assets/" + source.id + "/analysis";
  const verifyNative = measure || process.env.E2E_RELEASE_TARGET === "staging" || process.env.CUTROOM_TEST_WHISPER === "1";
  const nativeTranscript = verifyNative ? observeNativeTranscript(page, endpoint, uploadAt).catch(() => null) : null;
  const words: FixtureWord[] = [];
  function phrase(text: string, bounds: number[], offset: number) {
    for (const [i, word] of text.split(" ").entries())
      words.push({ text: word, startMs: offset + bounds[i], endMs: offset + bounds[i + 1] });
  }
  for (const offset of [0, 1700]) phrase("look at that picture", [0, 420, 700, 1060, 1660], offset);
  for (const offset of [4800, 6800]) phrase("you got a color film jim", [0, 250, 500, 580, 990, 1560, 1950], offset);
  const stamp = (ms: number) =>
    "00:" + String(Math.floor(ms / 1000)).padStart(2, "0") + "." + String(ms % 1000).padStart(3, "0");
  const subtitles =
    "WEBVTT\n\n" + words.map((w) => stamp(w.startMs) + " --> " + stamp(w.endMs) + "\n" + w.text).join("\n\n");
  await saveTranscript(page, endpoint, { revision: 0, subtitles }, words);
  for (const [i, w] of words.entries())
    await saveTranscript(page, endpoint, { revision: i + 1, index: i, correction: { startMs: w.startMs, endMs: w.endMs } }, words);
  const clip = mediaClip("interview", source.id, 0, source.duration);
  const added = await page.request.post(base + "/edits", {
      data: {
        kind: "edit",
        expectedRevision: original.revision,
        requestId: randomUUID(),
        operations: [{ type: "add", clip }],
      },
  });
  expect(added.status(), "Fixture clip insertion").toBe(200);
  await page.goto(editor);
  const uploadToNativeTranscriptMs = await nativeTranscript;
  if (verifyNative) expect(uploadToNativeTranscriptMs, "The uploaded interview must produce a native speech transcript.").not.toBeNull();
  return { read, base, original: await read(), editor, uploadToPlayableMs, uploadToNativeTranscriptMs, fixtureBytes: statSync(path).size };
}

async function accepted(page: Page, base: string) {
  const list = await (await page.request.get(base + "/rough-cuts")).json();
  const summary = list.reviews.find((r: { status: string }) => r.status === "applied");
  expect(summary).toBeTruthy();
  const detail = await (await page.request.get(base + "/rough-cuts/" + summary.id)).json();
  const receipt = roughCutReceiptSchema.parse(detail.receipt);
  expect(receipt.pauseCount).toBeGreaterThan(0);
  expect(receipt.repeatCount).toBe(1);
  expect(receipt.cuts.find((c) => c.kind === "repeat")?.text.toLowerCase()).toContain("look at that picture");
  expect(receipt.cuts.some((c) => c.kind === "repeat" && c.text.toLowerCase().includes("film"))).toBe(false);
  expect(detail.options.captions).toMatchObject({ style: "highlight", placement: "bottom" });
  return { detail, receipt };
}

test("rough-cut review plays both takes, restores a passage and exports the selected cut to a revocable phone link", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(300_000);
  const { base, read, original, editor, uploadToPlayableMs, uploadToNativeTranscriptMs, fixtureBytes } = await prepare(page, info);
  await page.getByRole("button", { name: "interview-takes.mp4 at frame 0" }).click();
  const chat = page.getByRole("region", { name: "Edit assistant" });
  await chat.getByRole("textbox", { name: "Ask Codex" }).fill(prompt);
  const turnAt = performance.now();
  await chat.getByRole("button", { name: "Send to Codex" }).click();
  const activity = chat.getByRole("list", { name: "Activity" });
  await expect(activity.getByText("Model received the candidate frame", { exact: true }).first()).toBeVisible({
    timeout: 160_000,
  });
  const submitToFirstCandidateMs = Math.round(performance.now() - turnAt);
  await expect(chat.getByText("Saved revision " + (original.revision + 1), { exact: true })).toBeVisible({
    timeout: 120_000,
  });
  const submitToSavedEditMs = Math.round(performance.now() - turnAt);
  await expect
    .poll(() => activity.getByText("Model received the candidate frame", { exact: true }).count(), { timeout: 120_000 })
    .toBeGreaterThanOrEqual(2);
  await expect(activity).toContainText("Model received the rendered frame", { timeout: 90_000 });
  await expect(chat.getByRole("button", { name: "Stop Codex" })).toHaveCount(0, { timeout: 60_000 });
  const { receipt } = await accepted(page, base);
  const saved = await read();
  expect(saved.revision).toBe(original.revision + 1);
  expect(original.timeline.durationInFrames - saved.timeline.durationInFrames).toBe(receipt.removedFrames);
  const captions = saved.timeline.clips
    .flatMap((c) => (c.kind === "text" && c.track === "caption" ? (c.caption?.words.map((w) => w.text) ?? []) : []))
    .join(" ");
  expect(captions.match(/look at that picture/gi)).toHaveLength(1);
  expect(captions.match(/you got a color film jim/gi)).toHaveLength(2);
  const repeat = receipt.cuts.find((c) => c.kind === "repeat")!;
  await page.reload();
  await page.getByRole("button", { name: /Open rough-cut review/ }).click();
  const box = page.getByRole("dialog", { name: "Rough-cut review" });
  await box.getByLabel("Choose passage").selectOption(repeat.id);
  for (const side of ["before", "after"]) {
    await box.getByRole("button", { name: "Play " + side }).click();
    const excerpt = box.getByRole("region", { name: new RegExp(side + " excerpt", "i") });
    await expect(excerpt).toBeVisible();
    await expect
      .poll(
        () =>
          excerpt
            .locator("video")
            .evaluateAll((nodes) =>
              nodes.some((n) => n instanceof HTMLVideoElement && n.readyState >= 2 && n.currentTime > 0 && !n.muted),
            ),
        { timeout: 15_000 },
      )
      .toBe(true);
  }
  const pause = receipt.cuts.find((c) => c.kind === "pause")!;
  await box.getByLabel("Choose passage").selectOption(pause.id);
  await box.getByRole("button", { name: "Play after" }).click();
  await expect(box.getByRole("region", { name: "After excerpt" }).locator("video").first()).toBeVisible();
  await box.getByRole("button", { name: "Play next caption" }).click();
  await expect
    .poll(() =>
      box
        .getByRole("region", { name: "After excerpt" })
        .locator("video")
        .evaluateAll((v) => v.some((n) => n instanceof HTMLVideoElement && !n.paused && n.currentTime > 0)),
    )
    .toBe(true);
  await box.getByLabel("Choose passage").selectOption(repeat.id);
  await box.getByRole("button", { name: "Restore this passage" }).click();
  await expect(box.getByRole("button", { name: "Passage restored" })).toBeDisabled();
  const restored = await read();
  expect(restored.timeline.durationInFrames - saved.timeline.durationInFrames).toBe(repeat.to - repeat.from);
  const restoredWords = restored.timeline.clips
    .flatMap((c) => (c.kind === "text" && c.caption ? c.caption.words.map((w) => w.text) : []))
    .join(" ");
  expect(restoredWords.match(/look at that picture/gi)).toHaveLength(2);
  await box.getByRole("button", { name: "Close rough-cut review" }).click();
  await page.goto(editor);
  await page.getByRole("button", { name: /Open rough-cut review/ }).click();
  await box.getByRole("button", { name: "Undo this edit" }).click();
  await expect.poll(async () => (await read()).timeline).toEqual(saved.timeline);
  const undoReview = box.getByRole("button", { name: "Undo this edit" });
  await expect(undoReview).toBeEnabled();
  // Delay the editor's snapshot after the next undo to reproduce dismissing the review on a slow connection.
  let releaseSnapshot!: () => void;
  const snapshot = new Promise<void>(resolve => { releaseSnapshot = resolve; });
  const route = new URL(base, webOrigin).href;
  await page.route(route, async request => { await snapshot; await request.continue(); });
  const redo = page.getByRole("button", { name: "Redo", exact: true });
  try {
    await undoReview.click();
    await expect.poll(async () => (await read()).timeline).toEqual(original.timeline);
    await box.getByRole("button", { name: "Close rough-cut review" }).click();
    await expect(redo).toBeDisabled();
  } finally {
    releaseSnapshot();
    await page.unroute(route);
  }
  await redo.click();
  await expect.poll(async () => (await read()).timeline).toEqual(saved.timeline);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect.poll(async () => (await read()).timeline).toEqual(restored.timeline);
  const captionsAfterRestore = restored.timeline.clips.filter((c) => c.kind === "text" && c.track === "caption");
  const caption = captionsAfterRestore[0];
  if (caption.kind !== "text") throw new Error("Expected a surviving caption.");
  await page.getByRole("button", { name: caption.text + " at frame " + caption.start, exact: true }).click();
  const inspector = page.getByRole("region", { name: "Clip inspector" });
  await inspector.getByLabel("Y position").fill(String(caption.y - 40));
  await inspector.getByRole("button", { name: "Save properties" }).click();
  await expect.poll(async () => (await read()).timeline.clips.find((c) => c.id === caption.id)?.y).toBe(caption.y - 40);
  const chosenRevision = (await read()).revision;
  const frameInspectionMs = measure ? await measureFrame(page, base, chosenRevision, caption.start).catch(() => null) : null;
  const renderAt = performance.now();
  const stop = new AbortController();
  const exportMetrics = measure ? observeExport(page, base, chosenRevision, renderAt, stop.signal).catch(() => null) : null;
  try {
    await page.getByRole("button", { name: "Export MP4", exact: true }).click();
    await expect(page.getByRole("link", { name: "Download MP4", exact: true }).first()).toBeVisible({ timeout: 150_000 });
  } catch (error) {
    stop.abort();
    throw error;
  }
  const renderToCompleteMs = Math.round(performance.now() - renderAt);
  const timings = { fixtureBytes, uploadToPlayableMs, submitToFirstCandidateMs, submitToSavedEditMs, renderToCompleteMs,
    ...(measure ? { uploadToNativeTranscriptMs, frameInspectionMs, ...await exportMetrics } : {}) };
  await info.attach("release-timings.json", {
    body: Buffer.from(JSON.stringify(timings)),
    contentType: "application/json",
  });
  console.info("Release walkthrough timings", JSON.stringify(timings));
  await page.reload();
  await page.getByRole("button", { name: "Export history", exact: true }).click();
  const history = page.getByRole("dialog", { name: "Export history" });
  const exported = history.getByRole("listitem").filter({ hasText: "Revision " + chosenRevision });
  await expect(exported.getByText("Revision " + chosenRevision, { exact: true })).toBeVisible();
  await expect(exported.getByRole("link", { name: "Download MP4" })).toBeVisible();
  await exported.getByRole("button", { name: "Create watch link", exact: true }).click();
  const watch = await exported.getByRole("link", { name: "Open watch link", exact: true }).getAttribute("href");
  const phone = await browser.newContext({ baseURL: webOrigin, viewport: { width: 390, height: 844 }, isMobile: true });
  try {
    const guest = await phone.newPage();
    await guest.goto(watch!);
    await expect(guest.locator("video")).toBeVisible();
    expect(
      await guest.locator("video").evaluate(async (v) => {
        if (!(v instanceof HTMLVideoElement)) return false;
        v.muted = true;
        await v.play();
        return v.readyState >= 2;
      }),
    ).toBe(true);
    await expect
      .poll(() => guest.locator("video").evaluate((v) => (v instanceof HTMLVideoElement ? v.currentTime : 0)))
      .toBeGreaterThan(0.2);
    await info.attach("watch-phone.png", { body: await guest.screenshot(), contentType: "image/png" });
    await exported.getByRole("button", { name: "Revoke watch link", exact: true }).click();
    await expect(exported.getByRole("button", { name: "Create watch link", exact: true })).toBeVisible({ timeout: 15_000 });
    await guest.reload();
    await expect(guest.getByText("This watch link is unavailable.")).toBeVisible({ timeout: 15_000 });
  } finally {
    await phone.close();
  }
});

test("external Codex inspects two rough-cut candidates, commits one edit group and checks the export job", async ({
  page,
}, info) => {
  test.setTimeout(260_000);
  const { base, read, original } = await prepare(page, info);
  const key = (await (await page.request.post(base + "/connection", { data: {} })).json()).key;
  await runExternalCodex({
    mcpUrl: webOrigin + "/api/mcp",
    token: key,
    prompt: prompt + " Start an export of the saved revision and check its status.",
    minCandidateImages: 2,
  });
  const { detail } = await accepted(page, base);
  const saved = await read();
  expect(saved.revision).toBe(original.revision + 1);
  const exports = await (await page.request.get(base + "/exports")).json();
  expect(exports.items).toHaveLength(1);
  expect(exports.items[0].revision).toBe(saved.revision);
  const call = async (name: string, args: object) => {
    const response = await page.request.post("/api/mcp", {
      headers: { Authorization: "Bearer " + key, Accept: "application/json, text/event-stream" },
      data: { jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name, arguments: args } },
    });
    expect(response.status(), "External MCP status").toBe(200);
    const { result } = await response.json();
    expect(result.isError).not.toBe(true);
    return JSON.parse(result.content[0].text);
  };
  const found = await call("rough_cut", { action: "inspect" });
  expect(found.reviews).toContainEqual(expect.objectContaining({ reviewId: detail.id, status: "applied" }));
  const compact = await call("rough_cut", { action: "inspect", reviewId: detail.id });
  expect(compact.cutCount).toBeGreaterThan(0);
  expect(compact).not.toHaveProperty("before");
  expect(compact).not.toHaveProperty("context");
  const status = await call("export_status", { exportId: exports.items[0].id });
  expect(status).toMatchObject({ revision: saved.revision, exportId: exports.items[0].id });
  expect(status).not.toHaveProperty("watchPath");
  expect(status).not.toHaveProperty("downloadUrl");
});
