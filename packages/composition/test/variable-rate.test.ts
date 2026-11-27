import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createEmptyTimeline, mediaClip, type Timeline } from "@editor/timeline";
import { prepareMedia } from "../../../apps/api/src/media";

const fps = 30;
const sourceFrames = [0, 2, 5, 11, 15, 18, 24, 30, 38, 39, 51, 59];
const sourceStart = 6, editStart = 3, clipLength = 51;

function timestamps(file: string) {
  const output = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_frames",
    "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", file], { encoding: "utf8" });
  const { frames }: { frames: { best_effort_timestamp_time: string }[] } = JSON.parse(output);
  return frames.map(frame => Number(frame.best_effort_timestamp_time));
}

function audibleFrames(file: string) {
  const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a:0", "-ar", "48000", "-ac", "1", "-f", "f32le", "pipe:1"]);
  const samplesPerFrame = 48000 / fps;
  const active: number[] = [];
  for (let frame = 0; (frame + 1) * samplesPerFrame * 4 <= pcm.length; frame++) {
    let squares = 0;
    for (let s = 0; s < samplesPerFrame; s++) squares += pcm.readFloatLE((frame * samplesPerFrame + s) * 4) ** 2;
    if (Math.sqrt(squares / samplesPerFrame) > .07) active.push(frame);
  }
  return active;
}

test("variable-rate upload preview and 30 fps export agree on source shots and audio after a trim and a move", async () => {
  const job = await mkdtemp(join(tmpdir(), "cutroom-vfr-"));
  try {
    const original = join(job, "original.mp4");
    const keep = sourceFrames.map(n => "eq(n," + n + ")").join("+");
    execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=red:s=160x90:r=30:d=2",
      "-f", "lavfi", "-i", "aevalsrc=0.5*sin(2*PI*800*t)*between(t\\,38/30\\,45/30):s=48000:d=2",
      "-vf", "drawbox=w=iw:h=ih:c=lime:t=fill:enable='gte(n,15)',drawbox=w=iw:h=ih:c=blue:t=fill:enable='gte(n,38)',select='" + keep + "'",
      "-fps_mode:v", "vfr", "-c:v", "libx264", "-bf", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", original]);
    const sourceTimes = timestamps(original);
    expect(sourceTimes.map(t => Math.round(t * fps))).toEqual(sourceFrames);
    expect(audibleFrames(original)).toEqual([38, 39, 40, 41, 42, 43, 44]);

    const processed = await prepareMedia(job, "video/mp4", (await stat(original)).size, "/assets/camera", fps);
    expect(processed).toMatchObject({ duration: 60, metadata: { hasAudio: true, width: 160, height: 90 } });
    const preview = join(job, "playback.mp4");
    await mkdir(join(job, "assets"));
    await copyFile(original, join(job, "assets", "camera.mp4"));
    const asset = { id: "camera", name: "Variable camera", src: "imports/camera.mp4", ...processed };
    const timeline: Timeline = { ...createEmptyTimeline("film", "Variable rate", "landscape"), width: 160, height: 90,
      durationInFrames: editStart + clipLength, assets: [asset], clips: [{ ...mediaClip("take", asset.id, editStart, clipLength), sourceStart }] };
    await writeFile(join(job, "timeline.json"), JSON.stringify(timeline));
    execFileSync("node", ["--import", "tsx", "src/render.ts"], { cwd: fileURLToPath(new URL("../../../apps/worker", import.meta.url)),
      env: { ...process.env, CUTROOM_RENDER_DIR: job, CUTROOM_RENDER_JOB: job }, timeout: 100_000 });
    const film = join(job, "output.mp4");
    const exportedTimes = timestamps(film);
    expect(exportedTimes).toHaveLength(54);
    for (const [frame, time] of exportedTimes.entries()) expect(time).toBeCloseTo(frame / fps, 5);

    const pixels = execFileSync("ffmpeg", ["-v", "error", "-i", film, "-map", "0:v:0", "-vf", "scale=1:1", "-fps_mode", "passthrough",
      "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]);
    const rgb = (frame: number) => [...pixels.subarray(frame * 3, frame * 3 + 3)];
    expect(Math.max(...rgb(2))).toBeLessThan(16);
    const positions = [3, 10, 11, 12, 14, 32, 34, 35, 37, 50];
    const expectedShots = [0, 0, 0, 1, 1, 1, 1, 2, 2, 2];
    const payload = (await readFile(preview)).toString("base64");
    const browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL });
    try {
      const page = await browser.newPage();
      const previewPixels = await page.evaluate(async ({ payload, times }) => {
        const video = document.createElement("video");
        video.muted = true;
        video.preload = "auto";
        video.src = "data:video/mp4;base64," + payload;
        await new Promise<void>((resolve, reject) => { video.onloadeddata = () => resolve(); video.onerror = () => reject(new Error("Preview failed to load")); });
        const canvas = document.createElement("canvas");
        canvas.width = 1; canvas.height = 1;
        const ctx = canvas.getContext("2d")!;
        const samples: number[][] = [];
        for (const time of times) {
          await new Promise<void>((resolve, reject) => { video.onseeked = () => resolve(); video.onerror = () => reject(new Error("Preview seek failed")); video.currentTime = time; });
          ctx.drawImage(video, 0, 0, 1, 1);
          samples.push([...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3));
        }
        return samples;
      }, { payload, times: positions.map(f => (sourceStart + f - editStart + .2) / fps) });
      for (const [index, frame] of positions.entries()) {
        const colour = rgb(frame), sample = previewPixels[index];
        expect(colour[expectedShots[index]]).toBeGreaterThan(200);
        for (const [channel, value] of colour.entries()) expect(Math.abs(value - sample[channel])).toBeLessThan(18);
      }
    } finally { await browser.close(); }

    const outputCue = audibleFrames(film);
    const firstBlue = exportedTimes.findIndex((_, frame) => rgb(frame)[2] > 200);
    // Source frame 38 starts both the blue shot and the tone. Its edited location is 38 - 6 + 3 = 35.
    expect(Math.abs(firstBlue - 35)).toBeLessThanOrEqual(1);
    expect(Math.abs(outputCue[0] - firstBlue)).toBeLessThanOrEqual(1);
    expect(Math.abs(outputCue.at(-1)! - 41)).toBeLessThanOrEqual(1);
    expect(outputCue.length).toBeGreaterThanOrEqual(6);
  } finally { await rm(job, { recursive: true, force: true }); }
}, 120_000);
