import { expect, test } from "bun:test";
import { applyPatch, createEmptyTimeline, editTimeline, mediaClip, prepareRoughCut, restorePassage, rushes, textClip, type TranscriptWord } from "../src";

const recording = rushes.id;
const original = editTimeline(createEmptyTimeline("film", "Studio", "landscape"), [
  { type: "add", clip: { ...mediaClip("camera", recording, 0, 150), linkId: "interview" } },
  { type: "add", clip: { ...mediaClip("mic", recording, 0, 150), track: "speech", linkId: "interview" } },
  { type: "add", clip: { ...mediaClip("bed", recording, 0, 150), track: "music" } },
]).timeline;
const word = (text: string, startMs: number, endMs: number): TranscriptWord => ({ text, startMs, endMs, timing: "word" });
const words = [word("Alpha", 0, 500), word("Beta", 2000, 2500), word("Gamma", 4000, 4500)];
const options = { target: { clipId: "camera" }, breathingRoomMs: 100 };

test("two pauses become a single reversible edit with breathing room, source-linked captions and an anchored music bed", () => {
  const draft = prepareRoughCut(original, { [recording]: words }, options, "draft");
  expect(draft.receipt).toMatchObject({ pauseCount: 2, removedFrames: 78, captionCount: 3,
    cuts: [{ from: 18, to: 57, at: 18 }, { from: 78, to: 117, at: 39 }] });
  const committed = editTimeline(original, draft.operations);
  expect(committed.timeline).toEqual(draft.timeline);
  expect(applyPatch(committed.timeline, committed.inverse)).toEqual(original);
  expect(draft.timeline.clips.filter(c => c.track === "video").map(c => [c.start, c.duration])).toEqual([[0, 18], [18, 21], [39, 33]]);
  expect(draft.timeline.clips.filter(c => c.track === "caption").map(c => c.start)).toEqual([0, 21, 42]);
  expect(draft.timeline.clips.find(c => c.id === "bed")).toEqual(original.clips.find(c => c.id === "bed"));
});

test("restore in either order preserves later titles, restores linked speech and cues, and detects overwritten source edits", () => {
  const draft = prepareRoughCut(original, { [recording]: words }, options, "restore");
  const committed = editTimeline(original, draft.operations);
  const title = textClip("later", "Added after review", 14, 30, 720);
  const current = editTimeline(committed.timeline, [{ type: "add", clip: title }]).timeline;
  for (const order of [[0, 1], [1, 0]]) {
    let timeline = current;
    const restored: string[] = [];
    for (const input of order) {
      const passage = draft.receipt.cuts[input];
      const change = editTimeline(timeline, restorePassage(timeline, draft.receipt, passage.id, restored));
      expect(applyPatch(change.timeline, change.inverse)).toEqual(timeline);
      timeline = change.timeline;
      restored.push(passage.id);
      expect(() => restorePassage(timeline, draft.receipt, passage.id, restored)).toThrow("unavailable");
    }
    expect(timeline.clips.filter(c => c.kind === "media")).toEqual(original.clips.filter(c => c.kind === "media"));
    expect(timeline.clips.find(c => c.id === "later")).toEqual(title);
    expect(timeline.clips.filter(c => c.track === "caption").map(c => c.start)).toEqual([0, 60, 120]);
  }
  const reframe = editTimeline(current, [{ type: "framing", id: "camera", rotation: 90, fit: "contain" }]);
  expect(() => restorePassage(reframe.timeline, draft.receipt, draft.receipt.cuts[0].id)).toThrow("changed");
  const locked = editTimeline(original, [{ type: "lock", track: "speech", locked: true }]);
  expect(() => prepareRoughCut(locked.timeline, { [recording]: words }, options, "locked")).toThrow("Unlock");
});

test("a passage crossing two split clips counts once, and a reused clip maps its own trimmed word interval", () => {
  const split = editTimeline(original, [
    { type: "split", id: "camera", frame: 40, rightId: "b" },
    { type: "add", clip: { ...mediaClip("reprise", recording, 160, 30), sourceStart: 60 } },
  ]).timeline;
  const draft = prepareRoughCut(split, { [recording]: words }, { ...options, target: { from: 10, to: 190 } }, "range");
  expect(draft.receipt.cuts).toMatchObject([{ from: 18, to: 57, sourceStartFrame: 18, sourceEndFrame: 57 },
    { from: 78, to: 117 }, { from: 178, to: 190, sourceStartFrame: 78, sourceEndFrame: 90 }]);
  expect(draft.timeline.clips.filter(c => c.track === "caption").map(c => [c.start, c.duration])).toEqual([[10, 5], [21, 15], [42, 15], [82, 15]]);
});

test("repeated-take preferences remove only the earlier confident take and restore its timed captions", () => {
  const phrase = ["Try", "this", "other", "way."];
  const transcript = [...phrase, ...phrase].map((text, i) => word(text, i * 300, (i + 1) * 300));
  const remove = prepareRoughCut(original, { [recording]: transcript }, { ...options, repetitions: "remove",
    captions: { style: "highlight", color: "#eeeeee", highlightColor: "#dd1100", font: "mono", fontSize: 41, placement: "top" } }, "take");
  expect(remove.receipt).toMatchObject({ repeatCount: 1, removedFrames: 36, cuts: [{ kind: "repeat", from: 0, to: 36, text: "Try this other way." }] });
  const caption = remove.timeline.clips.find(c => c.track === "caption");
  expect(caption).toMatchObject({ start: 0, y: 58, color: "#eeeeee", fontSize: 41, caption: { style: "highlight", font: "mono", highlightColor: "#dd1100",
    words: [{ text: "Try", from: 0, to: 9 }, { from: 9, to: 18 }, { from: 18, to: 27 }, { from: 27, to: 36 }] } });
  const restored = editTimeline(remove.timeline, restorePassage(remove.timeline, remove.receipt, remove.receipt.cuts[0].id));
  expect(restored.timeline.clips.filter(c => c.track === "caption")).toMatchObject([{ start: 0, text: phrase.join(" ") }, { start: 36, text: phrase.join(" ") }]);
  for (const preference of [{ repetitions: "keep" }, { repetitions: "remove", keepPhrases: ["TRY THIS!"] }, { repetitions: "flag" }] as const) {
    const draft = prepareRoughCut(original, { [recording]: transcript }, { ...options, repetitions: preference.repetitions,
      keepPhrases: [...(preference.keepPhrases ?? [])] }, "protected");
    expect(draft.receipt.repeatCount).toBe(0);
    if (preference.repetitions !== "keep") expect(draft.receipt.flags).toHaveLength(1);
  }
  const slogan = ["Go", "team!", "Go", "team!"].map((text, i) => word(text, i * 100, (i + 1) * 100));
  const flagged = prepareRoughCut(original, { [recording]: slogan }, { ...options, repetitions: "remove", captions: false }, "slogan");
  expect(flagged.operations).toHaveLength(0);
  expect(flagged.receipt.flags).toMatchObject([{ reason: "Possibly deliberate repetition" }]);
});

test("estimated passages can receive captions; automatic cuts require measured or reviewed boundaries", () => {
  const transcript = words.map((w): TranscriptWord => ({ ...w, timing: "estimated" }));
  const draft = prepareRoughCut(original, { [recording]: transcript }, options, "estimated");
  expect(draft.receipt).toMatchObject({ removedFrames: 0, captionCount: 3 });
  expect(draft.receipt.flags).toHaveLength(2);
  const noSpeech = prepareRoughCut(original, {}, options, "silence");
  expect(noSpeech.operations).toHaveLength(0);
  expect(noSpeech.timeline).toEqual(original);
});

test("moving a manually split and trimmed caption keeps its active words attached to the surviving audio", () => {
  const source = [word("Hi", 0, 300), word("there", 300, 800), word("again", 800, 1200)];
  const draft = prepareRoughCut(original, { [recording]: source }, { ...options, captions: { style: "highlight" } }, "words");
  const edited = editTimeline(draft.timeline, [
    { type: "split", id: "camera", frame: 15, rightId: "part-b" },
    { type: "trim", id: "part-b", edge: "left", frame: 20 },
    { type: "move", id: "part-b", start: 50 },
  ]);
  expect(edited.timeline.clips.filter(c => c.track === "caption")).toMatchObject([
    { start: 0, duration: 15, text: "Hi there", caption: { words: [{ text: "Hi", from: 0, to: 9 }, { text: "there", from: 9, to: 15 }] } },
    { start: 50, duration: 16, text: "there again", caption: { words: [{ text: "there", from: 0, to: 4 }, { text: "again", from: 4, to: 16 }] } },
  ]);
  expect(applyPatch(edited.timeline, edited.inverse)).toEqual(draft.timeline);
});
