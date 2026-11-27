import { z } from "zod";
import { id, type Clip, type Timeline } from "./model";

const milliseconds = z.int().nonnegative();
const wordText = z.string().trim().min(1).max(500);
export const sourceRangeSchema = z.strictObject({ startMs: milliseconds, endMs: milliseconds })
  .refine(range => range.startMs < range.endMs, "Choose a positive source interval.");
export type SourceRange = z.infer<typeof sourceRangeSchema>;
export const transcriptWordSchema = z.strictObject({
  text: wordText,
  startMs: milliseconds,
  endMs: milliseconds,
  timing: z.enum(["word", "estimated", "corrected"]),
}).refine(word => word.endMs > word.startMs, "A word needs a positive source interval.");
export type TranscriptWord = z.infer<typeof transcriptWordSchema>;

export const wordCorrectionSchema = z.strictObject({
  text: wordText.regex(/^\S+$/, "Edit one word at a time.").optional(),
  startMs: milliseconds.optional(), endMs: milliseconds.optional(),
}).refine(edit => (edit.startMs === undefined) === (edit.endMs === undefined), "Review both source boundaries.")
  .refine(edit => edit.text !== undefined || edit.startMs !== undefined, "Choose a word correction.");
export type WordCorrection = z.infer<typeof wordCorrectionSchema>;

export function correctWord(words: readonly TranscriptWord[], index: number, correction: WordCorrection, durationMs: number): TranscriptWord[] {
  const original = words[index];
  if (!original) throw new Error("Word outside the transcript.");
  const edit = wordCorrectionSchema.parse(correction);
  if (edit.endMs !== undefined && edit.endMs > durationMs) throw new Error("Word outside the source duration.");
  const replacement = transcriptWordSchema.parse({
    text: edit.text ?? original.text, startMs: edit.startMs ?? original.startMs, endMs: edit.endMs ?? original.endMs,
    timing: edit.startMs === undefined ? original.timing : "corrected",
  });
  return words.map((word, i) => i === index ? replacement : word);
}

function cueMs(stamp: string) {
  const match = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)[.,](\d{3})$/.exec(stamp);
  if (!match) throw new Error("Invalid subtitle timestamp.");
  return ((Number(match[1] ?? 0) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 + Number(match[4]);
}

export function parseSubtitles(content: string, durationMs: number): TranscriptWord[] {
  if (content.length > 1_000_000) throw new Error("The subtitle file is too large.");
  const blocks = content.trim().replace(/\r\n?/g, "\n").split(/\n[ \t]*\n/);
  const webVTT = /^WEBVTT(?:[ \t\n]|$)/.test(blocks[0]);
  if (webVTT) blocks.shift();
  const words: TranscriptWord[] = [];
  for (const block of blocks) {
    if (webVTT && /^(?:NOTE|STYLE|REGION)(?:[ \t\n]|$)/.test(block)) continue;
    const lines = block.split("\n");
    const timingLine = lines[0].includes("-->") ? 0 : 1;
    const match = /^(\S+)\s+-->\s+(\S+)(?:[ \t]+.*)?$/.exec(lines[timingLine]?.trim() ?? "");
    if (!match) throw new Error("Expected a subtitle cue with start and end timestamps.");
    const start = cueMs(match[1]);
    const end = cueMs(match[2]);
    if (start >= end || end > durationMs) throw new Error("Subtitle cue outside the source duration.");
    const text = lines.slice(timingLine + 1).join(" ").replace(/<[^<>\n]+>/g, "")
      .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, entity: string) => entities[entity]);
    const tokens = text.trim().split(/\s+/).filter(Boolean);
    if (tokens.length > end - start) throw new Error("Subtitle cue too short for its words.");
    if (tokens.length + words.length > 20_000) throw new Error("The subtitle file contains too many words.");
    for (const [i, token] of tokens.entries()) {
      words.push(transcriptWordSchema.parse({
        text: token, startMs: start + Math.floor((end - start) * i / tokens.length),
        endMs: start + Math.floor((end - start) * (i + 1) / tokens.length), timing: "estimated",
      }));
    }
  }
  if (!words.length) throw new Error("No words found in the subtitle file.");
  return words;
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export const transcriptQuerySchema = z.union([z.strictObject({ phrase: z.string().trim().min(1).max(500) }), sourceRangeSchema]);
export type TranscriptQuery = z.infer<typeof transcriptQuerySchema>;
export type TranscriptMatch = TranscriptWord & { firstWord: number; lastWord: number };

function searchTokens(text: string) {
  return text.normalize("NFKC").toLowerCase().replace(/['’]/g, "").match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

function matchWords(words: readonly TranscriptWord[], firstWord: number, lastWord: number): TranscriptMatch {
  const span = words.slice(firstWord, lastWord + 1);
  // Imported or overlapping cues retain authored word order, which can differ from timestamp order.
  return {
    firstWord, lastWord, text: span.map(w => w.text).join(" "),
    startMs: span.reduce((min, word) => Math.min(min, word.startMs), span[0].startMs),
    endMs: span.reduce((max, word) => Math.max(max, word.endMs), span[0].endMs),
    timing: span.some(w => w.timing === "estimated") ? "estimated" : span.every(w => w.timing === "corrected") ? "corrected" : "word",
  };
}

export function lookupTranscript(words: readonly TranscriptWord[], query: TranscriptQuery): TranscriptMatch[] {
  transcriptQuerySchema.parse(query);
  const matches: TranscriptMatch[] = [];
  if ("phrase" in query) {
    const phrase = searchTokens(query.phrase);
    if (!phrase.length) return matches;
    const tokens = words.flatMap((word, index) => searchTokens(word.text).map(text => ({ text, index })));
    for (let i = 0; i <= tokens.length - phrase.length; i++) {
      if (!phrase.every((token, j) => tokens[i + j].text === token)) continue;
      const first = tokens[i].index;
      const last = tokens[i + phrase.length - 1].index;
      if (matches.at(-1)?.firstWord !== first || matches.at(-1)?.lastWord !== last) matches.push(matchWords(words, first, last));
    }
  } else {
    let first: number | undefined;
    for (const [i, word] of words.entries()) {
      if (word.startMs < query.endMs && query.startMs < word.endMs) {
        first ??= i;
        if (i - first === 49) { matches.push(matchWords(words, first, i)); first = undefined; }
      } else if (first !== undefined) { matches.push(matchWords(words, first, i - 1)); first = undefined; }
    }
    if (first !== undefined) matches.push(matchWords(words, first, words.length - 1));
  }
  return matches;
}

export const sourceScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("all") }),
  z.strictObject({ kind: z.literal("clip"), clipId: id }),
]);
export type SourceScope = z.infer<typeof sourceScopeSchema>;
export type SourcePlacement = {
  clipId: string; track: Extract<Clip, { kind: "media" }>["track"];
  startFrame: number; endFrame: number; sourceStartFrame: number; sourceEndFrame: number;
};

export function mapSourceRange(timeline: Timeline, assetId: string, { startMs, endMs }: SourceRange, scope: SourceScope): SourcePlacement[] {
  sourceRangeSchema.parse({ startMs, endMs });
  // Include each frame whose exposure intersects the source interval, even for a word shorter than a frame.
  const firstFrame = Math.floor(startMs * timeline.fps / 1000);
  const endFrame = Math.ceil(endMs * timeline.fps / 1000);
  const placements: SourcePlacement[] = [];
  for (const clip of timeline.clips) {
    if (clip.kind !== "media" || clip.assetId !== assetId || (scope.kind === "clip" && scope.clipId !== clip.id)) continue;
    const sourceStartFrame = Math.max(firstFrame, clip.sourceStart);
    const sourceEndFrame = Math.min(endFrame, clip.sourceStart + clip.duration);
    if (sourceStartFrame >= sourceEndFrame) continue;
    placements.push({ clipId: clip.id, track: clip.track, sourceStartFrame, sourceEndFrame,
      startFrame: clip.start + sourceStartFrame - clip.sourceStart, endFrame: clip.start + sourceEndFrame - clip.sourceStart });
  }
  return placements.sort((a, b) => a.startFrame - b.startFrame || a.clipId.localeCompare(b.clipId));
}
