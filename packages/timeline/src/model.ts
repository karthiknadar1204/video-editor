import { z } from "zod";

export const tracks = ["video", "speech", "music", "title", "caption"] as const;
export const trackSchema = z.enum(tracks);
export type Track = z.infer<typeof trackSchema>;
export const frame = z.int().nonnegative();
export const id = z.string().min(1).max(200);
const coordinate = z.int().min(-10000).max(10000);
export const fitSchema = z.enum(["cover", "contain"]);
export const rotationSchema = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);
const fontSize = z.int().min(8).max(400);
const color = z.string().regex(/^#[0-9a-f]{6}$/i);
export const captionLookSchema = z.strictObject({
  style: z.enum(["readable", "highlight"]).default("readable"),
  font: z.enum(["sans", "serif", "mono"]).default("sans"), placement: z.enum(["top", "center", "bottom"]).default("bottom"),
  color: color.default("#ffffff"), highlightColor: color.default("#ffcf61"), fontSize: fontSize.optional(),
});
const timedCaption = z.strictObject({
  reviewId: id, style: z.enum(["readable", "highlight"]), font: z.enum(["sans", "serif", "mono"]), highlightColor: color,
  words: z.array(z.strictObject({ text: z.string().min(1).max(500), from: frame, to: z.int().positive() })
    .refine(w => w.to > w.from)).max(32),
});
const common = {
  id, start: frame, duration: z.int().positive(), linkId: id.nullable(),
  x: coordinate, y: coordinate,
};
export const clipSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...common, kind: z.literal("media"), track: z.enum(["video", "speech", "music"]),
    assetId: id, sourceStart: frame, volume: z.number().min(0).max(1), fit: fitSchema.optional(), rotation: rotationSchema.optional() }),
  z.strictObject({ ...common, kind: z.literal("text"), track: z.enum(["title", "caption"]),
    text: z.string().trim().min(1).max(2000), fontSize, color, caption: timedCaption.optional() }),
]);
export type Clip = z.infer<typeof clipSchema>;
export const assetSchema = z.object({
  id, name: z.string(), src: z.string(), duration: z.int().positive(),
  metadata: z.object({
    mediaType: z.enum(["video", "audio"]), width: frame, height: frame, rotation: z.number(),
    hasAudio: z.boolean(), size: z.int().positive(), thumbnail: z.string().optional(),
    audio: z.object({ codec: z.string(), channels: z.int().positive(), sampleRate: z.int().positive() }).optional(),
    transcript: z.enum(["not-started", "unavailable"]),
  }).optional(),
});
export const timelineSchema = z.object({
  id, name: z.string(), width: z.int().positive(), height: z.int().positive(), fps: z.int().positive(),
  durationInFrames: frame, assets: z.array(assetSchema), clips: z.array(clipSchema), lockedTracks: z.array(trackSchema),
});
export type Timeline = z.infer<typeof timelineSchema>;
export const rushes = { id: "earthrise-rushes", name: "Earthrise rushes", src: "media/earthrise-rushes.mp4", duration: 600 };
export const sample = { id: "earthrise", name: "Earthrise", src: "media/earthrise.mp4", duration: 300 };

export function mediaClip(clipId: string, assetId: string, start: number, duration: number): Extract<Clip, { kind: "media" }> {
  return { kind: "media", id: clipId, assetId, track: "video", start, duration, sourceStart: 0, volume: 1, x: 0, y: 0, linkId: null };
}
export function textClip(clipId: string, text: string, start: number, duration: number, height: number): Extract<Clip, { kind: "text" }> {
  return { kind: "text", id: clipId, track: "title", text, start, duration, x: 68, y: Math.round(height * 420 / 720),
    fontSize: 76, color: "#ffffff", linkId: null };
}

export const changeSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("add"), clip: clipSchema }),
  z.strictObject({ type: z.literal("move"), id, start: frame, track: trackSchema.optional() }),
  z.strictObject({ type: z.literal("trim"), id, edge: z.enum(["left", "right"]), frame }),
  z.strictObject({ type: z.literal("split"), id, frame, rightId: id }),
  z.strictObject({ type: z.literal("delete"), id }),
  z.strictObject({ type: z.literal("rippleDelete"), id, tracks: z.array(trackSchema).max(tracks.length), cutId: id }),
  z.strictObject({ type: z.literal("text"), id, text: z.string().trim().min(1).max(2000) }),
  z.strictObject({ type: z.literal("position"), id, x: coordinate, y: coordinate }),
  z.strictObject({ type: z.literal("framing"), id, fit: fitSchema, rotation: rotationSchema }),
  z.strictObject({ type: z.literal("textStyle"), id, fontSize, color }),
  z.strictObject({ type: z.literal("volume"), id, volume: z.number().min(0).max(1) }),
  z.strictObject({ type: z.literal("lock"), track: trackSchema, locked: z.boolean() }),
  z.strictObject({ type: z.literal("link"), ids: z.array(id).min(2), linkId: id }),
  z.strictObject({ type: z.literal("roughCut"), reviewId: id, remove: z.array(id), put: z.array(clipSchema) }),
  z.strictObject({ type: z.literal("restorePassage"), reviewId: id, cutId: id, remove: z.array(id), put: z.array(clipSchema) }),
]);
export type Change = z.infer<typeof changeSchema>;
export function isReviewOperation(op: Change) { return op.type === "roughCut" || op.type === "restorePassage"; }
const request = { requestId: z.uuid(), expectedRevision: frame };
export const editSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...request, kind: z.literal("edit"), operations: z.array(changeSchema).min(1).max(200) }),
  z.strictObject({ ...request, kind: z.literal("undo") }),
  z.strictObject({ ...request, kind: z.literal("redo") }),
]);
export type EditRequest = z.infer<typeof editSchema>;
export function editLabel(command: EditRequest) {
  if (command.kind !== "edit") return command.kind === "undo" ? "Undo edit" : "Redo edit";
  const names: Record<Change["type"], string> = {
    add: "Insert clip", move: "Move clip", trim: "Trim clip", split: "Split clip", delete: "Delete clip",
    rippleDelete: "Ripple delete", text: "Edit text", position: "Reposition clip", framing: "Frame shot",
    textStyle: "Style text", volume: "Adjust volume", lock: "Change track lock", link: "Link clips",
    roughCut: "Rough cut and captions", restorePassage: "Restore passage",
  };
  return [...new Set(command.operations.map(op => names[op.type]))].join(" + ");
}
export const projectSnapshot = z.object({
  id: z.uuid(), title: z.string(), revision: frame, formatVersion: z.literal(2), timeline: timelineSchema,
  canUndo: z.boolean(), canRedo: z.boolean(),
  history: z.array(z.object({ revision: frame, label: z.string(), from: frame.nullable() })).default([]),
});
export type ProjectSnapshot = z.infer<typeof projectSnapshot>;
