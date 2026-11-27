import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { Timeline } from "@editor/timeline";

const exec = promisify(execFile);
export const maxBytes = 64 * 1024 * 1024;
const formats = new Map([
  ["video/mp4", ["mp4", "mov"]], ["video/quicktime", ["mov", "mov"]],
  ["video/webm", ["webm", "webm"]], ["audio/mp4", ["m4a", "mov"]], ["audio/x-m4a", ["m4a", "mov"]],
  ["audio/mpeg", ["mp3", "mp3"]], ["audio/wav", ["wav", "wav"]], ["audio/x-wav", ["wav", "wav"]],
  ["audio/webm", ["webm", "webm"]], ["audio/ogg", ["ogg", "ogg"]],
]);

export function originalName(mime: string) {
  const format = formats.get(mime);
  if (!format) throw new MediaError("Choose an MP4, MOV, WebM, M4A, MP3, WAV, or Ogg file.", 415);
  return "original." + format[0];
}

export class MediaError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 413 | 415 | 422 | 503) { super(message); }
}

const probeSchema = z.object({
  format: z.object({ duration: z.coerce.number().positive().max(3600), format_name: z.string() }),
  streams: z.array(z.object({
    index: z.int(), codec_type: z.string(), codec_name: z.string(), width: z.number().optional(), height: z.number().optional(),
    channels: z.int().positive().optional(), sample_rate: z.coerce.number().int().positive().optional(),
    side_data_list: z.array(z.object({ rotation: z.number().optional() })).optional(),
    disposition: z.object({ attached_pic: z.number() }).optional(),
  })),
});
const inputOptions = ["-protocol_whitelist", "file", "-format_whitelist", "mov,matroska,webm,mp3,wav,ogg"];

export async function prepareMedia(folder: string, mime: string, size: number, base: string, fps: number) {
  const input = join(folder, originalName(mime));
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR };
  try {
    const { stdout } = await exec("ffprobe", ["-v", "error", ...inputOptions, "-show_format", "-show_streams", "-of", "json", input],
      { env, timeout: 20_000, maxBuffer: 512 * 1024 });
    const info = probeSchema.parse(JSON.parse(stdout));
    const video = info.streams.find(s => s.codec_type === "video" && !s.disposition?.attached_pic);
    const sound = info.streams.find(s => s.codec_type === "audio");
    const hasAudio = Boolean(sound);
    const container = formats.get(mime)?.[1];
    if (!container || !info.format.format_name.split(",").includes(container) || Boolean(video) !== mime.startsWith("video/") || (!video && !hasAudio)) {
      throw new MediaError("The file contents do not match the selected media type.", 415);
    }
    const rotation = video?.side_data_list?.find(d => d.rotation !== undefined)?.rotation ?? 0;
    const sideways = Math.abs(rotation) % 180 === 90;
    const width = video?.width ?? 0, height = video?.height ?? 0;
    if (video && (!width || !height || width * height > 8192 * 4320)) throw new MediaError("Video dimensions are unsupported.", 422);
    const run = (args: string[]) => exec("ffmpeg", ["-nostdin", "-v", "error", "-y", "-threads", "2", ...inputOptions,
      "-i", input, "-filter_threads", "1", ...args], { env, timeout: 180_000, maxBuffer: 256 * 1024 });
    const fit = "scale=w='min(960,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1";
    if (video) {
      await run(["-map", "0:" + video.index, "-map", "0:a:0?", "-vf", fit, "-r", String(fps),
        "-c:v", "libx264", "-threads", "2", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-g", String(fps),
        "-map_metadata", "-1", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", join(folder, "playback.mp4")]);
      await run(["-map", "0:" + video.index, "-frames:v", "1", "-vf", "scale=320:-2", "-threads", "1", join(folder, "thumbnail.jpg")]);
    } else {
      await run(["-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", join(folder, "playback.mp4")]);
    }
    const metadata: NonNullable<Timeline["assets"][number]["metadata"]> = {
      mediaType: video ? "video" : "audio", width: sideways ? height : width, height: sideways ? width : height,
      rotation, hasAudio, size, ...(video ? { thumbnail: base + "/thumbnail" } : {}),
      ...(sound?.channels && sound.sample_rate ? { audio: { codec: sound.codec_name, channels: sound.channels, sampleRate: sound.sample_rate } } : {}),
      transcript: hasAudio ? "not-started" : "unavailable",
    };
    return { duration: Math.max(1, Math.floor(info.format.duration * fps + 0.00001)), metadata };
  } catch (error) {
    if (error instanceof MediaError) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new MediaError("Media processing is unavailable. Install ffmpeg and ffprobe on the media worker.", 503);
    throw new MediaError("Could not decode this recording. Choose a supported file of up to one hour.", 422);
  }
}
