import { z } from "zod";
import { EditError, editTimeline, sameClip, sliceClip } from "./edits";
import type { TranscriptWord } from "./footage";
import { captionLookSchema, frame, id, type Change, type Clip, type Timeline } from "./model";

export const roughCutOptionsSchema = z.strictObject({
  target: z.union([z.strictObject({ clipId: id }), z.strictObject({ from: frame, to: frame }).refine(r => r.to > r.from)]),
  pauseThresholdMs: z.int().min(100).max(60_000).default(1000),
  breathingRoomMs: z.int().min(0).max(5000).default(120),
  repetitions: z.enum(["keep", "flag", "remove"]).default("flag"),
  keepPhrases: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  captions: z.union([z.literal(false), captionLookSchema]).optional(),
});
export type RoughCutOptions = z.input<typeof roughCutOptionsSchema>;
type Options = z.output<typeof roughCutOptionsSchema>;
type Media = Extract<Clip, { kind: "media" }>;
type Text = Extract<Clip, { kind: "text" }>;
type Look = z.output<typeof captionLookSchema>;
const passage = z.object({
  assetId: id, clipId: id, from: frame, to: frame, sourceStartFrame: frame, sourceEndFrame: frame, text: z.string(),
});
export const roughCutReceiptSchema = z.object({
  id, pauseCount: frame, repeatCount: frame, removedFrames: frame, captionCount: frame,
  cuts: z.array(passage.extend({ id, kind: z.enum(["pause", "repeat"]), at: frame })),
  flags: z.array(passage.extend({ reason: z.string() })), previewFrames: z.array(frame),
});
type Summary = z.infer<typeof roughCutReceiptSchema>;
export type RoughCutReceipt = Summary & { context: { clips: Clip[] } };
type Cut = Summary["cuts"][number];
type Word = { text: string; timing: TranscriptWord["timing"]; startMs: number; endMs: number; from: number; to: number };

function localWords(clip: Media, words: readonly TranscriptWord[], fps: number, from: number, to: number): Word[] {
  const offset = clip.start - clip.sourceStart;
  return words.flatMap(w => {
    const first = Math.max(from, offset + Math.floor(w.startMs * fps / 1000));
    const last = Math.min(to, offset + Math.ceil(w.endMs * fps / 1000));
    return first < last ? [{ ...w, from: first, to: last }] : [];
  }).sort((a, b) => a.from - b.from || a.startMs - b.startMs);
}

function passageFor(clip: Media, from: number, to: number, text: string) {
  return { clipId: clip.id, assetId: clip.assetId, from, to, text,
    sourceStartFrame: clip.sourceStart + from - clip.start, sourceEndFrame: clip.sourceStart + to - clip.start };
}

const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/['’]/g, "").replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim();

function detect(clip: Media, words: Word[], source: readonly TranscriptWord[], selection: { from: number; to: number }, fps: number, options: Options, receipt: Summary) {
  const add = (kind: Cut["kind"], from: number, to: number, text: string, reason?: string) => {
    if (to <= from) return;
    const source = passageFor(clip, from, to, text);
    if (reason) receipt.flags.push({ ...source, reason });
    else receipt.cuts.push({ ...source, kind, id: receipt.id + ":cut:" + receipt.cuts.length, at: from });
  };
  // A known gap can cross a split or fill a trimmed selection containing no surviving spoken word.
  const ordered = [...source].sort((a, b) => a.startMs - b.startMs);
  let prior = ordered[0];
  for (const next of ordered.slice(1)) {
    if (next.startMs - prior.endMs >= options.pauseThresholdMs) {
      const offset = clip.start - clip.sourceStart;
      const from = Math.max(selection.from, offset + Math.ceil((prior.endMs + options.breathingRoomMs) * fps / 1000));
      const to = Math.min(selection.to, offset + Math.floor((next.startMs - options.breathingRoomMs) * fps / 1000));
      add("pause", from, to, prior.text + " … " + next.text,
        prior.timing === "estimated" || next.timing === "estimated" ? "Estimated word boundaries" : undefined);
    }
    if (next.endMs >= prior.endMs) prior = next;
  }
  if (options.repetitions === "keep") return;
  const tokens = words.map(w => normalize(w.text));
  const keep = options.keepPhrases.map(normalize).filter(Boolean);
  for (let i = 0; i < words.length - 1; i++) {
    for (let n = Math.min(16, Math.floor((words.length - i) / 2)); n >= 2; n--) {
      const first = tokens.slice(i, i + n);
      if (!first.every((token, j) => token && token === tokens[i + n + j])) continue;
      const run = words.slice(i, i + 2 * n);
      const text = words.slice(i, i + n).map(w => w.text).join(" ");
      const phrase = " " + first.join(" ") + " ";
      const protectedTake = keep.some(k => phrase.includes(" " + k + " ") || (" " + k + " ").includes(phrase));
      const thirdTake = first.every((token, j) => token === tokens[i + n * 2 + j]);
      const periodic = first.some((_, k) => k > 0 && n % k === 0 && first.every((token, j) => token === first[j % k]));
      const estimated = run.some(w => w.timing === "estimated");
      const reason = protectedTake ? "Requested phrase preserved" : estimated ? "Estimated word boundaries"
        : n < 4 || new Set(first).size < 3 || thirdTake || periodic ? "Possibly deliberate repetition" : options.repetitions === "flag" ? "Repeated take for review" : undefined;
      const from = words[i].from, to = words[i + n - 1].to;
      // Clip reuse is handled separately. Never delete later speech overlapping the presumed first take.
      add("repeat", from, to, text, reason ?? (to > words[i + n].from ? "Overlapping takes" : undefined));
      i += (thirdTake ? 3 : 2) * n - 1;
      break;
    }
  }
  // A repeated complete line with intervening dialogue may be intentional.
  const seen = new Map<string, Word[]>();
  let line: Word[] = [];
  for (const [i, word] of words.entries()) {
    line.push(word);
    if (words[i + 1] && !/[.!?]$/.test(word.text) && words[i + 1].startMs - word.endMs < 700) continue;
    const key = normalize(line.map(w => w.text).join(" "));
    const earlier = seen.get(key);
    if (line.length >= 2 && earlier && earlier.at(-1)!.to < line[0].from &&
      !receipt.cuts.some(c => c.clipId === clip.id && c.from <= earlier[0].from && c.to >= earlier.at(-1)!.to) &&
      !receipt.flags.some(c => c.clipId === clip.id && c.from === earlier[0].from && c.to === earlier.at(-1)!.to)) {
      add("repeat", earlier[0].from, earlier.at(-1)!.to, earlier.map(w => w.text).join(" "), "Repeated line for review");
    }
    seen.set(key, line); line = [];
  }
}

function captions(words: Word[], clip: Media, look: Look, timeline: Timeline, prefix: string, reviewId: string): Text[] {
  const cues: Text[] = [];
  let group: Word[] = [];
  const flush = () => {
    if (!group.length) return;
    const start = group[0].from, end = Math.max(...group.map(w => w.to));
    cues.push({ id: prefix + ":cue:" + cues.length, kind: "text", track: "caption", start, duration: end - start, linkId: clip.linkId,
      x: Math.round(timeline.width * .06), y: Math.round(timeline.height * ({ top: .08, center: .44, bottom: .78 })[look.placement]),
      fontSize: look.fontSize ?? Math.max(18, Math.round(timeline.height * .052)), color: look.color,
      text: group.map(w => w.text).join(" "), caption: { reviewId, style: look.style, font: look.font, highlightColor: look.highlightColor,
        words: group.map(w => ({ text: w.text, from: w.from - start, to: w.to - start })) } });
    group = [];
  };
  for (const w of words) {
    const last = group.at(-1);
    if (last && w.from >= Math.max(...group.map(t => t.to)) && (group.length >= 5 || /[.!?]$/.test(last.text) ||
      w.startMs - last.endMs >= 600 || group.map(v => v.text).join(" ").length + w.text.length > 36)) flush();
    if (group.length >= 32) throw new EditError("Review overlapping transcript words before generating captions.");
    group.push(w);
  }
  flush();
  return cues;
}

function cutClips(clips: Clip[], cuts: Cut[]): Clip[] {
  const groups = new Map<string, { index: number; from: number }>();
  for (const [i, c] of clips.entries()) {
    if (!c.linkId) continue;
    const group = groups.get(c.linkId);
    if (group) group.from = Math.min(group.from, c.start);
    else groups.set(c.linkId, { index: i, from: c.start });
  }
  return clips.flatMap((clip, index) => {
    const pieces: Clip[] = [], end = clip.start + clip.duration;
    const group = clip.linkId ? groups.get(clip.linkId) : undefined;
    let cursor = clip.start, shift = 0, linkId = clip.linkId, lastCut = "";
    function append(to: number) {
      if (cursor >= to) return;
      const part = cursor === clip.start && to === end ? { ...clip } : sliceClip(clip, cursor, to);
      if (part.kind === "text" && part.caption && !part.caption.words.length) return;
      pieces.push({ ...part, start: cursor - shift, linkId, id: pieces.length ? lastCut + ":part:" + index : clip.id });
    }
    for (const cut of cuts) {
      if (cut.from >= end) break;
      append(cut.from);
      cursor = Math.max(cursor, cut.to);
      shift += cut.to - cut.from;
      lastCut = cut.id;
      if (group && group.from < cut.from) linkId = cut.id + ":link:" + group.index;
    }
    append(end);
    return pieces;
  });
}

function replacement(before: Clip[], after: Clip[]) {
  const old = new Map(before.map(c => [c.id, c])), current = new Set(after.map(c => c.id));
  return { remove: before.filter(c => !current.has(c.id)).map(c => c.id),
    put: after.filter(c => { const prior = old.get(c.id); return !prior || !sameClip(prior, c); }) };
}

export function prepareRoughCut(timeline: Timeline, transcripts: Record<string, TranscriptWord[]>, input: RoughCutOptions, draftId: string) {
  const options = roughCutOptionsSchema.parse(input);
  const prefix = "review:" + z.string().min(1).max(100).parse(draftId) + ":";
  const target = options.target;
  const media = timeline.clips.filter((c): c is Media => c.kind === "media" && c.track !== "music");
  let selections: Media[];
  if ("clipId" in target) selections = media.filter(c => c.id === target.clipId);
  else {
    if (target.to > timeline.durationInFrames) throw new EditError("Choose a range inside the timeline.");
    const overlapping = media.filter(c => c.start < target.to && c.start + c.duration > target.from);
    const hasWords = (clip: Media) => localWords(clip, transcripts[clip.assetId] ?? [], timeline.fps,
      Math.max(clip.start, target.from), Math.min(clip.start + clip.duration, target.to)).length > 0;
    const candidates = overlapping.filter(hasWords);
    const track = (candidates.length ? candidates : overlapping).some(c => c.track === "video") ? "video" : "speech";
    selections = overlapping.filter(c => c.track === track);
  }
  if (!selections.length) throw new EditError("Choose a video or speech clip in the timeline.");
  if (timeline.clips.some(c => c.id.startsWith(prefix))) throw new EditError("This rough cut already exists.");
  const lane = selections[0].track;
  const links = new Set(timeline.clips.filter(c => c.track === lane && c.linkId).map(c => c.linkId));
  const original = timeline.clips.filter(c => c.track === lane || (c.linkId && links.has(c.linkId)));
  const seed = original.map(c => ({ ...c }));
  const receipt: RoughCutReceipt = { id: draftId, pauseCount: 0, repeatCount: 0, removedFrames: 0, captionCount: 0,
    cuts: [], flags: [], previewFrames: [], context: { clips: seed } };
  const look = options.captions === false ? false : options.captions ?? captionLookSchema.parse({});
  for (const [i, clip] of selections.entries()) {
    const from = "clipId" in target ? clip.start : Math.max(clip.start, target.from);
    const to = "clipId" in target ? clip.start + clip.duration : Math.min(clip.start + clip.duration, target.to);
    const source = transcripts[clip.assetId] ?? [];
    const words = localWords(clip, source, timeline.fps, from, to);
    detect(clip, words, source, { from, to }, timeline.fps, options, receipt);
    if (words.length && look) {
      const owner = seed.find((c): c is Media => c.id === clip.id && c.kind === "media")!;
      owner.linkId ??= prefix + "take:" + i;
      seed.push(...captions(words, owner, look, timeline, prefix + i, draftId));
    }
  }
  // A removed take may contain internal pauses. Its whole source range is one replayable passage.
  const repeats = receipt.cuts.filter(c => c.kind === "repeat");
  receipt.cuts = receipt.cuts.filter(c => c.kind === "repeat" || !repeats.some(r => r.from < c.to && c.from < r.to)).sort((a, b) => a.from - b.from);
  const merged: Cut[] = [];
  for (const cut of receipt.cuts) {
    const last = merged.at(-1);
    if (cut.kind === "pause" && last?.kind === "pause" && last.assetId === cut.assetId && last.to === cut.from &&
      last.sourceEndFrame === cut.sourceStartFrame && last.text === cut.text) {
      last.to = cut.to; last.sourceEndFrame = cut.sourceEndFrame;
    } else merged.push(cut);
  }
  receipt.cuts = merged;
  for (const cut of receipt.cuts) {
    cut.at = cut.from - receipt.removedFrames;
    receipt.removedFrames += cut.to - cut.from;
    if (cut.kind === "pause") receipt.pauseCount++; else receipt.repeatCount++;
  }
  const after = cutClips(seed, receipt.cuts);
  const changes = replacement(original, after);
  const operations: Change[] = changes.put.length || changes.remove.length ? [{ type: "roughCut", reviewId: draftId, ...changes }] : [];
  const result = operations.length ? editTimeline(timeline, operations).timeline : timeline;
  const generated = after.filter((c): c is Text => c.kind === "text" && c.caption?.reviewId === draftId);
  receipt.captionCount = generated.length;
  const samples = [...receipt.cuts.flatMap(c => [c.at - 1, c.at]),
    ...generated.flatMap(c => c.caption?.style === "highlight" ? c.caption.words.map(w => c.start + w.from) : [c.start]),
    ...result.clips.filter(c => c.track === "title" || c.kind === "media" && (c.rotation || c.fit === "contain" || c.x || c.y)).map(c => c.start)];
  receipt.previewFrames = [...new Set(samples.filter(f => f >= 0 && f < result.durationInFrames))].sort((a, b) => a - b);
  return { timeline: result, operations, receipt };
}

export function restorePassage(timeline: Timeline, receipt: RoughCutReceipt, cutId: string, restoredIds: string[] = []): Change[] {
  if (!receipt.cuts.some(c => c.id === cutId) || restoredIds.includes(cutId)) throw new EditError("This passage is unavailable for restoration.");
  const remaining = receipt.cuts.filter(c => !restoredIds.includes(c.id));
  const expected = cutClips(receipt.context.clips, remaining);
  const after = cutClips(receipt.context.clips, remaining.filter(c => c.id !== cutId));
  const delta = replacement(expected, after);
  const old = new Map(expected.map(c => [c.id, c])), current = new Map(timeline.clips.map(c => [c.id, c]));
  const touchedLinks = new Set<string>();
  for (const key of [...delta.remove, ...delta.put.map(c => c.id)]) {
    const a = old.get(key), b = current.get(key);
    if (a && b ? !sameClip(a, b) : a !== b) throw new EditError("Clips around this passage changed. Undo those edits before restoring it.");
    if (a?.linkId) touchedLinks.add(a.linkId);
  }
  if (timeline.clips.some(c => c.linkId && touchedLinks.has(c.linkId) && !old.has(c.id))) throw new EditError("A newly linked clip would be displaced by this restore.");
  const operation: Change = { type: "restorePassage", reviewId: receipt.id, cutId, ...delta };
  editTimeline(timeline, [operation]);
  return [operation];
}
