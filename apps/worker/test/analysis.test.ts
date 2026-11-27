import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { makeSourceSheet, transcribeSource } from "../src/analysis";
import { fixturePath } from "../whisper";

const exec = promisify(execFile);

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
