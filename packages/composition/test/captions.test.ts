import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEmptyTimeline, mediaClip, prepareRoughCut, rushes, type Timeline, type TranscriptWord } from "@editor/timeline";

test("the exported film highlights only the currently spoken word and draws readable captions in their assigned position", async () => {
  const job = await mkdtemp(join(tmpdir(), "cutroom-captions-"));
  try {
    const width = 320, height = 180;
    const timeline: Timeline = { ...createEmptyTimeline("film", "Captions", "landscape"), width, height, durationInFrames: 48,
      clips: [{ ...mediaClip("voice", rushes.id, 0, 48), track: "speech" }] };
    const words: TranscriptWord[] = [
      { text: "FIRST", startMs: 100, endMs: 400, timing: "word" }, { text: "SECOND", startMs: 400, endMs: 700, timing: "word" },
      { text: "READABLE", startMs: 900, endMs: 1400, timing: "word" },
    ];
    const source = { [rushes.id]: words };
    const first = prepareRoughCut(timeline, source, { target: { from: 0, to: 24 }, captions: {
      style: "highlight", placement: "top", font: "mono", fontSize: 26, color: "#ffffff", highlightColor: "#ff2020",
    } }, "highlight").timeline;
    const second = prepareRoughCut(first, source, { target: { from: 24, to: 48 }, captions: {
      style: "readable", placement: "bottom", font: "serif", fontSize: 24, color: "#ffffff", highlightColor: "#ff2020",
    } }, "readable").timeline;
    await mkdir(join(job, "assets"));
    await writeFile(join(job, "timeline.json"), JSON.stringify(second));
    execFileSync("node", ["--import", "tsx", "src/render.ts"], {
      cwd: fileURLToPath(new URL("../../../apps/worker", import.meta.url)),
      env: { ...process.env, CUTROOM_RENDER_JOB: job, CUTROOM_RENDER_DIR: job }, timeout: 100_000,
    });
    const rgb = execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-i", join(job, "output.mp4"), "-vf",
      "select='eq(n,3)+eq(n,12)+eq(n,22)+eq(n,30)'", "-fps_mode", "passthrough", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]);
    const stride = width * height * 3;
    expect(rgb.length).toBe(4 * stride);
    const frames = Array.from({ length: 4 }, (_, frame) => {
      let red = 0, bright = 0, redX = 0, redY = 0, brightY = 0;
      for (let i = 0; i < width * height; i++) {
        const j = frame * stride + i * 3;
        const y = Math.floor(i / width);
        if (rgb[j] > 155 && rgb[j + 1] < 95 && rgb[j + 2] < 95) { red++; redX += i % width; redY += y; }
        if (Math.min(rgb[j], rgb[j + 1], rgb[j + 2]) > 175) { bright++; brightY += y; }
      }
      return { red, bright, redX: redX / red, redY: redY / red, brightY: brightY / bright };
    });
    for (const highlighted of frames.slice(0, 2)) {
      expect(highlighted.red).toBeGreaterThan(50);
      expect(highlighted.bright).toBeGreaterThan(50);
      expect(highlighted.redY).toBeLessThan(height / 2);
    }
    expect(frames[1].redX - frames[0].redX).toBeGreaterThan(50);
    expect(frames[2]).toMatchObject({ red: 0, bright: 0 });
    expect(frames[3].red).toBe(0);
    expect(frames[3].bright).toBeGreaterThan(100);
    expect(frames[3].brightY).toBeGreaterThan(height * .7);
  } finally { await rm(job, { recursive: true, force: true }); }
}, 120_000);
