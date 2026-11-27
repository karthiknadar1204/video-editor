import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createEmptyTimeline, editTimeline, mediaClip, prepareRoughCut, rushes } from "@editor/timeline";
import sharp from "sharp";
import { makeSourceSheet, nativeWords, transcribeSource } from "../src/analysis";
import { fixturePath } from "../whisper";

const exec = promisify(execFile);

test("recognized words past the media end survive with bounded estimated times", () => {
  const row = (text: string, from: number, to: number) => ({ text, offsets: { from, to } });
  const words = nativeWords([
    row("before", 7000, 7760), row("a", 7760, 9750), row("color", 9750, 10060), row("film", 10060, 10680),
  ], 8800);
  expect(words.map(w => w.text)).toEqual(["before", "a", "color", "film"]);
  expect(words[0]).toEqual({ text: "before", timing: "word", startMs: 7000, endMs: 7760 });
  expect(words.slice(1).every(w => w.timing === "estimated")).toBe(true);
  expect(words.every((w, i) => w.startMs >= (words[i-1]?.endMs ?? 0) && w.endMs > w.startMs && w.endMs <= 8800)).toBe(true);
});

test("ambiguous silence preserves a word crossing two audible regions; an internal zero-length estimate leaves its next anchor intact", () => {
  const words = nativeWords([
    { text: "both", offsets: { from: 0, to: 500 } },
    { text: "then", offsets: { from: 500, to: 500 } },
    { text: "next", offsets: { from: 600, to: 800 } },
  ], 800, [{ startMs: 90, endMs: 370 }]);
  expect(words).toEqual([
    { text: "both", timing: "estimated", startMs: 0, endMs: 500 },
    { text: "then", timing: "estimated", startMs: 500, endMs: 600 },
    { text: "next", timing: "word", startMs: 600, endMs: 800 },
  ]);
});

test.skipIf(process.env.CUTROOM_TEST_WHISPER !== "1")("a measured pause between two speech excerpts survives native recognition and rough-cut planning", async () => {
  const folder = await mkdtemp(join(tmpdir(), "cutroom-spoken-pause-"));
  try {
    const path = join(folder, "pause.wav");
    await exec("ffmpeg", ["-nostdin", "-v", "error", "-i", fixturePath, "-filter_complex",
      "[0:a]atrim=start=0.3:end=4.8,asetpts=PTS-STARTPTS[a];anullsrc=r=16000:cl=mono,atrim=duration=2.4[s];" +
      "[0:a]atrim=start=4.8:end=10.5,asetpts=PTS-STARTPTS[b];[a][s][b]concat=n=3:v=0:a=1[out]", "-map", "[out]", "-ar", "16000", path]);
    const transcript = await transcribeSource({ path, durationMs: 12_600, hasAudio: true });
    const timeline = editTimeline(createEmptyTimeline("film", "Interview", "landscape"), [
      { type: "add", clip: mediaClip("interview", rushes.id, 0, 378) },
    ]).timeline;
    const { receipt } = prepareRoughCut(timeline, { [rushes.id]: transcript.words },
      { target: { clipId: "interview" }, pauseThresholdMs: 2000, breathingRoomMs: 120 }, "review");
    expect(receipt.cuts).toContainEqual(expect.objectContaining({ kind: "pause",
      from: Math.ceil((4500 + 120) * timeline.fps / 1000), to: Math.floor((6900 - 120) * timeline.fps / 1000) }));
  } finally { await rm(folder, { recursive: true, force: true }); }
}, 60_000);

test("a silent source produces no words and a labelled sheet of decoded source frames", async () => {
  const folder = await mkdtemp(join(tmpdir(), "cutroom-silent-"));
  try {
    const path = join(folder, "silent.mp4");
    await exec("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=red:s=160x90:r=10:d=1",
      "-f", "lavfi", "-i", "color=blue:s=160x90:r=10:d=1", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2:a", "-t", "2",
      "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", path]);
    for (const hasAudio of [true, false]) {
      expect(await transcribeSource({ path, durationMs: 2000, hasAudio })).toEqual({ status: "no-speech", words: [] });
    }
    const sheet = await makeSourceSheet({ path, durationMs: 2000, fps: 10 });
    expect(sheet.mimeType).toBe("image/jpeg");
    expect(sheet.timestampsMs).toEqual([0, 300, 600, 1000, 1300, 1600]);
    const { data, info } = await sharp(Buffer.from(sheet.data, "base64")).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3);
    expect(pixel(120, 90)[0]).toBeGreaterThan(220);
    expect(pixel(120, 260)[2]).toBeGreaterThan(220);
    const textRegion = data.subarray(162 * info.width * 3, 188 * info.width * 3);
    expect(textRegion.some(channel => channel > 195)).toBe(true);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test.skipIf(process.env.CUTROOM_TEST_WHISPER !== "1")("the pinned recognizer decodes real human speech with individual word offsets", async () => {
  const transcript = await transcribeSource({ path: fixturePath, durationMs: 11_000, hasAudio: true });
  expect(transcript.status).toBe("ready");
  expect(transcript.words.map(w => w.text.toLowerCase()).join(" ")).toContain("ask not what your country can do for you");
  expect(transcript.words.every(w => w.timing === "word" && w.startMs < w.endMs && w.endMs <= 11_000)).toBe(true);
  const firstAsk = transcript.words.find(w => w.text.toLowerCase() === "ask");
  expect(firstAsk?.startMs).toBeGreaterThan(2500);
  expect(firstAsk?.startMs).toBeLessThan(4500);
}, 60_000);
