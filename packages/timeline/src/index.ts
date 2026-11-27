import { z } from "zod";
import { frame, mediaClip, rushes, sample, textClip, timelineSchema, type Timeline } from "./model";
export * from "./model";
export * from "./edits";
export * from "./codex";

export const canvasFormats = ["landscape", "portrait", "square"] as const;
export type CanvasFormat = typeof canvasFormats[number];
const dimensions = { landscape: [1280, 720], portrait: [720, 1280], square: [1080, 1080] } as const;

export function createEmptyTimeline(id: string, name: string, format: CanvasFormat): Timeline {
  const [width, height] = dimensions[format];
  return { id, name, width, height, fps: 30, durationInFrames: 0, assets: [rushes], clips: [], lockedTracks: [] };
}

export const earthrise: Timeline = {
  ...createEmptyTimeline("Earthrise", "Earthrise", "landscape"),
  durationInFrames: 300, assets: [sample],
  clips: [mediaClip("apollo-8", sample.id, 0, 300), textClip("earthrise-title", "Earthrise", 150, 150, 720)],
};

const legacy = timelineSchema.omit({ assets: true, clips: true, lockedTracks: true }).extend({
  videoTrack: z.array(z.object({ id: z.string(), src: z.string(), start: frame, sourceStart: frame, duration: z.int().positive() })),
  title: z.object({ text: z.string(), start: frame, duration: z.int().positive() }).nullable(),
});

// Phase 2 documents are upgraded on read and stored in the new format on their first edit.
export function readTimeline(version: number, stored: unknown): Timeline {
  if (version === 2) return timelineSchema.parse(stored);
  if (version !== 1) throw new Error("Unsupported timeline version " + version);
  const { videoTrack, title, ...base } = legacy.parse(stored);
  const assets = [{ ...rushes }];
  const clips: Timeline["clips"] = videoTrack.map(c => {
    let asset = assets.find(a => a.src === c.src);
    if (!asset) {
      asset = c.src === sample.src ? { ...sample } : { id: "legacy-" + assets.length, src: c.src, name: c.src, duration: 0 };
      assets.push(asset);
    }
    asset.duration = Math.max(asset.duration, c.sourceStart + c.duration);
    return { ...mediaClip(c.id, asset.id, c.start, c.duration), sourceStart: c.sourceStart };
  });
  if (title) {
    let titleId = "legacy-title";
    while (clips.some(c => c.id === titleId)) titleId += "-";
    clips.push(textClip(titleId, title.text, title.start, title.duration, base.height));
  }
  return { ...base, assets, clips, lockedTracks: [] };
}
