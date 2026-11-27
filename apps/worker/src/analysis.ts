import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { transcriptWordSchema, type TranscriptWord } from "@editor/timeline";
import sharp, { type OverlayOptions } from "sharp";
import { z } from "zod";
import { cliPath, modelPath } from "../whisper";

export { analysisVersion } from "../whisper";
const exec = promisify(execFile);
const localInput = ["-protocol_whitelist", "file", "-format_whitelist", "mov,matroska,webm,mp3,wav,ogg"];
const mediaOptions = { env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }, killSignal: "SIGKILL" as const };
const duration = z.int().positive().max(3_600_000);
const nativeOutput = z.object({ transcription: z.array(z.object({
  text: z.string(), offsets: z.object({ from: z.int().nonnegative(), to: z.int().nonnegative() }),
})).max(30_000) });

type Silence = { startMs: number; endMs: number };

function measuredSilences(stderr: string): Silence[] {
  return Array.from(stderr.matchAll(/silence_start: ([\d.eE+-]+)[\s\S]*?silence_end: ([\d.eE+-]+)/g), m => ({
    startMs: Math.ceil(Number(m[1]) * 1000), endMs: Math.floor(Number(m[2]) * 1000),
  }));
}

export function nativeWords(transcription: z.infer<typeof nativeOutput>["transcription"], durationMs: number, silences: Silence[] = []) {
  const recognized = transcription.flatMap(({ text, offsets }) => {
    const line = text.trim();
    if (!line || /^\[(blank_audio|silence|music)\]$/i.test(line)) return [];
    const tokens = line.split(/\s+/);
    const boundary = (i: number) => offsets.from + Math.floor((offsets.to - offsets.from) * i / tokens.length);
    return tokens.map((token, i): TranscriptWord => ({ text: token, timing: tokens.length === 1 ? "word" : "estimated",
      startMs: boundary(i), endMs: boundary(i + 1) }));
  });
  const words: TranscriptWord[] = [];
  let previousEnd = 0;
  function estimateUntil(index: number, nextStart: number) {
    const first = words.length;
    const boundary = (i: number) => previousEnd + Math.floor((nextStart - previousEnd) * (i - first) / (index - first));
    for (let i = first; i < index; i++) {
      const startMs = Math.min(durationMs - 1, boundary(i));
      words.push({ ...recognized[i], timing: "estimated", startMs, endMs: Math.max(startMs + 1, boundary(i + 1)) });
    }
  }
  for (const [i, word] of recognized.entries()) {
    // Keep native anchors when every intervening word still fits in the available source milliseconds.
    if (word.endMs <= word.startMs || word.startMs - previousEnd < i - words.length ||
        durationMs - word.endMs < recognized.length - i - 1) continue;
    estimateUntil(i, word.startMs);
    words.push(word);
    previousEnd = word.endMs;
  }
  estimateUntil(recognized.length, durationMs);

  let firstSilence = 0;
  for (const word of words) {
    while (firstSilence < silences.length && silences[firstSilence].endMs <= word.startMs) firstSilence++;
    for (let i = firstSilence; i < silences.length && silences[i].startMs < word.endMs; i++) {
      const quiet = silences[i];
      if (quiet.startMs <= word.startMs && quiet.endMs < word.endMs) word.startMs = quiet.endMs;
      else if (quiet.startMs > word.startMs && quiet.endMs >= word.endMs) word.endMs = quiet.startMs;
      else word.timing = "estimated"; // No unique spoken side, or the word lies entirely in silence.
    }
  }
  return words.map(word => transcriptWordSchema.parse(word));
}

type Transcript = { status: "ready" | "no-speech"; words: TranscriptWord[] };
export async function transcribeSource(input: { path: string; durationMs: number; hasAudio: boolean }): Promise<Transcript> {
  const durationMs = duration.parse(input.durationMs);
  if (!input.hasAudio) return { status: "no-speech", words: [] };
  const folder = await mkdtemp(join(tmpdir(), "cutroom-speech-"));
  try {
    const wav = join(folder, "audio.wav");
    const { stderr } = await exec("ffmpeg", ["-nostdin", "-hide_banner", "-nostats", "-threads", "2", ...localInput,
      "-i", input.path, "-map", "0:a:0", "-vn", "-af", "aresample=16000:async=1:first_pts=0,silencedetect=n=-65dB:d=0.25,volumedetect",
      "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-t", String(durationMs / 1000), wav],
      { ...mediaOptions, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
    const peak = /max_volume:\s*(-?[\d.]+) dB/.exec(stderr);
    if (peak && Number(peak[1]) <= -80) return { status: "no-speech", words: [] };
    const silences = measuredSilences(stderr);
    const offsetMs = silences[0]?.startMs === 0 ? Math.max(0, silences[0].endMs - 100) : 0;
    const prefix = join(folder, "speech");
    await exec(cliPath, ["-m", modelPath, "-f", wav, "-l", "en", "-t", "4", "-ng", "-np",
      "-ot", String(offsetMs), "-ml", "1", "-sow", "-oj", "-of", prefix], { ...mediaOptions, timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024 });
    if ((await stat(prefix + ".json")).size > 8 * 1024 * 1024) throw new Error();
    const { transcription } = nativeOutput.parse(JSON.parse(await readFile(prefix + ".json", "utf8")));
    const words = nativeWords(transcription, durationMs, silences);
    return { status: words.length ? "ready" : "no-speech", words };
  } catch {
    throw new Error("Could not transcribe this source. Check the pinned Whisper installation or import subtitles.");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

const tileWidth = 240, tileHeight = 136, labelHeight = 26;
function stamp(ms: number) {
  return String(Math.floor(ms / 60_000)).padStart(2, "0") + ":" +
    String(Math.floor(ms / 1000) % 60).padStart(2, "0") + "." + String(ms % 1000).padStart(3, "0");
}
function label(text: string, width: number) {
  return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="26">' +
    '<text x="8" y="18" font-family="sans-serif" font-size="13" fill="#ffffff">' + text + '</text></svg>');
}

export async function makeSourceSheet(input: { path: string; durationMs: number; fps: number }) {
  const durationMs = duration.parse(input.durationMs), fps = z.number().positive().max(240).parse(input.fps);
  const frames = Math.max(1, Math.floor(durationMs * fps / 1000));
  const count = Math.min(6, frames);
  const tiles: { image: Buffer; ms: number }[] = [];
  try {
    for (let i = 0; i < count; i++) {
      const targetMs = Math.floor(i * frames / count) * 1000 / fps;
      const { stdout, stderr } = await exec("ffmpeg", ["-nostdin", "-hide_banner", "-nostats", "-threads", "2", ...localInput,
        "-ss", (targetMs / 1000).toFixed(6), "-i", input.path, "-map", "0:V:0", "-an", "-frames:v", "1",
        "-filter_threads", "1", "-vf", "scale=240:136:force_original_aspect_ratio=decrease,pad=240:136:(ow-iw)/2:(oh-ih)/2,setsar=1,showinfo",
        "-threads", "1", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"],
        { ...mediaOptions, encoding: "buffer", timeout: 30_000, maxBuffer: 512 * 1024 });
      if (!stdout.length) continue;
      const pts = /\bpts_time:\s*(\S+)/.exec(stderr.toString());
      if (!pts || !Number.isFinite(Number(pts[1]))) throw new Error();
      const ms = Math.max(0, Math.round(targetMs + Number(pts[1]) * 1000));
      if (ms < durationMs && ms !== tiles.at(-1)?.ms) tiles.push({ image: stdout, ms });
    }
    if (!tiles.length) throw new Error();
    const width = tileWidth * Math.min(3, tiles.length);
    const layers: OverlayOptions[] = [{ input: label("SOURCE FOOTAGE", width), top: 0, left: 0 }];
    for (const [index, tile] of tiles.entries()) {
      const left = index % 3 * tileWidth, top = labelHeight + Math.floor(index / 3) * (tileHeight + labelHeight);
      layers.push({ input: tile.image, top, left }, { input: label(stamp(tile.ms), tileWidth), top: top + tileHeight, left });
    }
    const height = labelHeight + Math.ceil(tiles.length / 3) * (tileHeight + labelHeight);
    const jpeg = await sharp({ create: { width, height, channels: 3, background: "#181b20" } }).composite(layers).jpeg({ quality: 82 }).toBuffer();
    return { mimeType: "image/jpeg" as const, data: jpeg.toString("base64"), timestampsMs: tiles.map(t => t.ms) };
  } catch {
    throw new Error("Could not sample frames from this source video.");
  }
}
