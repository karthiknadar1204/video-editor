import { expect, test } from "bun:test";
import { correctWord, createEmptyTimeline, editTimeline, lookupTranscript, mapSourceRange, mediaClip, parseSubtitles, rushes, type SourcePlacement, type TranscriptWord } from "../src";

test("SRT and WebVTT import the same spoken words and keep line-level timing estimated", () => {
  const srt = "\uFEFF1\r\n00:00:01,000 --> 00:00:02,001\r\n<i>Hello</i>\r\nworld!\r\n";
  const vtt = "WEBVTT\nKind: captions\n\nNOTE an editor's comment\nignore me\n\ncue-a\n00:01.000 --> 00:02.001 align:start\n<v Speaker>Hello\nworld!</v>";
  const words: TranscriptWord[] = [
    { text: "Hello", startMs: 1000, endMs: 1500, timing: "estimated" },
    { text: "world!", startMs: 1500, endMs: 2001, timing: "estimated" },
  ];
  expect(parseSubtitles(srt, 3000)).toEqual(words);
  expect(parseSubtitles(vtt, 3000)).toEqual(words);
});

test("invalid or out-of-source cues cannot partially replace a transcript", () => {
  const good = "1\n00:00:01,100 --> 00:00:01,300\nhello\n\n";
  for (const cue of [
    "invalid", "00:00:01,400 --> 00:00:01,399", "00:00:01,400 --> 00:00:02,001",
    "00:00:09 --> 00:00:10", "00:00:01,400 --> 00:00:01,401",
  ]) expect(() => parseSubtitles(good + cue + "\nthese words", 2000)).toThrow();
  expect(() => parseSubtitles("WEBVTT\n\nNOTE no speech", 2000)).toThrow();
});

test("overlapping WebVTT cues keep authored phrase order and escaped caption text", () => {
  const words = parseSubtitles("WEBVTT\n\n00:00.000 --> 00:02.000\nI &lt;3 it!\n\n00:00.200 --> 00:00.900\nMe too.", 2000);
  expect(lookupTranscript(words, { phrase: "me too" })).toEqual([
    { firstWord: 3, lastWord: 4, text: "Me too.", startMs: 200, endMs: 900, timing: "estimated" },
  ]);
  expect(lookupTranscript(words, { startMs: 700, endMs: 800 }).map(m => [m.text, m.startMs, m.endMs]))
    .toEqual([["<3", 666, 1333], ["too.", 550, 900]]);
});

test("phrase search returns every complete normalized phrase, preserving source text and timing quality", () => {
  const words: TranscriptWord[] = [
    { text: "Well-known,", startMs: 0, endMs: 500, timing: "word" },
    { text: "don’t!", startMs: 700, endMs: 900, timing: "corrected" },
    { text: "well", startMs: 1200, endMs: 1399, timing: "corrected" },
    { text: "known", startMs: 1400, endMs: 1550, timing: "estimated" },
    { text: "DON'T", startMs: 1550, endMs: 1800, timing: "corrected" },
  ];
  expect(lookupTranscript(words, { phrase: "Well known don't" })).toEqual([
    { firstWord: 0, lastWord: 1, text: "Well-known, don’t!", startMs: 0, endMs: 900, timing: "word" },
    { firstWord: 2, lastWord: 4, text: "well known DON'T", startMs: 1200, endMs: 1800, timing: "estimated" },
  ]);
  expect(lookupTranscript(words, { phrase: "know" })).toEqual([]);
  expect(lookupTranscript(words, { startMs: 900, endMs: 1200 })).toEqual([]);
  expect(lookupTranscript(words, { startMs: 899, endMs: 1201 })).toEqual([
    { firstWord: 1, lastWord: 2, text: "don’t! well", startMs: 700, endMs: 1399, timing: "corrected" },
  ]);
});

test("one source phrase maps to surviving portions of split, trimmed, and repeated uses", () => {
  const timeline = editTimeline(createEmptyTimeline("test", "Footage", "landscape"), [
    { type: "add", clip: { ...mediaClip("first", rushes.id, 60, 90), sourceStart: 30 } },
    { type: "split", id: "first", frame: 90, rightId: "second" },
    { type: "trim", id: "second", edge: "left", frame: 95 },
    { type: "add", clip: { ...mediaClip("repeat", rushes.id, 200, 12), sourceStart: 60, track: "speech" } },
  ]).timeline;
  const range = { startMs: 1955, endMs: 2333 };
  const placements: SourcePlacement[] = [
    { clipId: "first", track: "video", startFrame: 88, endFrame: 90, sourceStartFrame: 58, sourceEndFrame: 60 },
    { clipId: "second", track: "video", startFrame: 95, endFrame: 100, sourceStartFrame: 65, sourceEndFrame: 70 },
    { clipId: "repeat", track: "speech", startFrame: 200, endFrame: 210, sourceStartFrame: 60, sourceEndFrame: 70 },
  ];
  expect(mapSourceRange(timeline, rushes.id, range, { kind: "all" })).toEqual(placements);
  expect(mapSourceRange(timeline, rushes.id, range, { kind: "clip", clipId: "second" })).toEqual([placements[1]]);
  expect(mapSourceRange(timeline, rushes.id, { startMs: 20, endMs: 1000 }, { kind: "all" })).toEqual([]);
  expect(mapSourceRange(timeline, rushes.id, { startMs: 2000, endMs: 2166 }, { kind: "clip", clipId: "first" })).toEqual([]);
  expect(mapSourceRange(timeline, "another asset", range, { kind: "all" })).toEqual([]);
});

test("correcting spelling preserves timing evidence; reviewing both boundaries updates only that word", () => {
  const input = parseSubtitles("1\n00:00:00,000 --> 00:00:02,000\nspelled rong", 2000);
  const edited = correctWord(input, 1, { text: "right" }, 2000);
  expect(edited[1]).toEqual({ text: "right", startMs: 1000, endMs: 2000, timing: "estimated" });
  const reviewed = correctWord(edited, 1, { startMs: 1100, endMs: 1960 }, 2000);
  expect(reviewed[1]).toEqual({ text: "right", startMs: 1100, endMs: 1960, timing: "corrected" });
  expect(input.map(word => word.text)).toEqual(["spelled", "rong"]);
  expect(reviewed[0]).toEqual(input[0]);
  for (const correction of [{}, { text: "" }, { startMs: 100 }, { startMs: 1960, endMs: 1000 }, { startMs: 0, endMs: 2001 }]) {
    expect(() => correctWord(input, 0, correction, 2000)).toThrow();
  }
  expect(() => correctWord(input, 2, { text: "new" }, 2000)).toThrow();
});
