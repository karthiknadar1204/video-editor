import { expect, test } from "bun:test";
import { applyPatch, editTimeline } from "../src/edits";
import { mediaClip, rushes, textClip, type Timeline, type Clip } from "../src/model";

const empty: Timeline = { id: "project", name: "Cut", width: 1280, height: 720, fps: 30, durationInFrames: 0,
  assets: [rushes], clips: [], lockedTracks: [] };
const media = (id: string, start: number, duration: number) => mediaClip(id, rushes.id, start, duration);
const title = (id: string, start: number, duration: number) => textClip(id, "Hello", start, duration, 720);
const withClips = (...clips: Clip[]) => editTimeline(empty, clips.map(clip => ({ type: "add", clip }))).timeline;

test("split uses source-relative frames and both patches reproduce the exact documents", () => {
  const t = withClips({ ...media("picture", 150, 180), sourceStart: 360 });
  const edit = editTimeline(t, [{ type: "split", id: "picture", frame: 210, rightId: "take-2" }]);
  expect(edit.timeline.clips).toMatchObject([{ start: 150, duration: 60, sourceStart: 360 }, { start: 210, duration: 120, sourceStart: 420 }]);
  expect(edit.affected).toEqual({ from: 150, to: 330 });
  expect(applyPatch(edit.timeline, edit.inverse)).toEqual(t);
  expect(applyPatch(t, edit.forward)).toEqual(edit.timeline);
  for (const at of [150, 330]) expect(() => editTimeline(t, [{ type: "split", id: "picture", frame: at, rightId: "x" }])).toThrow();
});

test("grouped trim, move, position, text and gain validate together; failure leaves the input alone", () => {
  const t = withClips(media("v", 0, 100), title("t", 0, 100));
  const edit = editTimeline(t, [
    { type: "trim", id: "v", edge: "left", frame: 20 }, { type: "trim", id: "v", edge: "right", frame: 90 },
    { type: "move", id: "v", start: 10 }, { type: "volume", id: "v", volume: .3 },
    { type: "text", id: "t", text: "New title" }, { type: "position", id: "t", x: 12, y: 42 },
  ]);
  expect(edit.timeline.clips).toMatchObject([{ start: 10, duration: 70, sourceStart: 20, volume: .3 }, { text: "New title", x: 12, y: 42 }]);
  expect(applyPatch(edit.timeline, edit.inverse)).toEqual(t);
  expect(() => editTimeline(t, [{ type: "delete", id: "t" }, { type: "trim", id: "v", edge: "right", frame: 601 }])).toThrow();
  expect(t.clips).toHaveLength(2);
  expect(() => editTimeline(t, [{ type: "add", clip: media("collision", 99, 1) }])).toThrow();
  expect(editTimeline(t, [{ type: "add", clip: media("touch", 100, 1) }]).timeline.durationInFrames).toBe(101);
});

test("linked splits keep cues with the right take and leave unrelated music anchored", () => {
  const t = withClips({ ...media("v", 20, 100), linkId: "take" }, { ...media("a", 20, 100), track: "speech", linkId: "take" },
    { ...title("words", 70, 20), track: "caption", linkId: "take" }, { ...media("bed", 0, 150), track: "music" });
  const split = editTimeline(t, [{ type: "split", id: "v", frame: 60, rightId: "right" }, { type: "move", id: "right", start: 80 }]).timeline;
  expect(split.clips.find(c => c.id === "words")?.start).toBe(90);
  const deleted = editTimeline(split, [{ type: "delete", id: "right" }]);
  expect(deleted.timeline.clips.map(c => c.id)).toEqual(["v", "a", "bed"]);
  expect(applyPatch(deleted.timeline, deleted.inverse)).toEqual(split);
});

test("ripple handles crossing cuts, linked tracks, locks and explicit music selection", () => {
  const t = withClips(media("cut", 20, 20), { ...media("next", 50, 30), linkId: "after" },
    { ...title("line", 52, 10), track: "caption", linkId: "after" },
    { ...media("voice", 10, 70), track: "speech" }, { ...media("music", 0, 100), track: "music" });
  const op = { type: "rippleDelete", id: "cut", tracks: ["speech"], cutId: "r" } as const;
  const edit = editTimeline(t, [{ ...op, tracks: [...op.tracks] }]);
  expect(edit.timeline.clips).toMatchObject([{ id: "next", start: 30 }, { id: "voice", duration: 10 },
    { track: "speech", start: 20, sourceStart: 30, duration: 40 }, { id: "music", start: 0, duration: 100 }, { id: "line", start: 32 }]);
  expect(applyPatch(edit.timeline, edit.inverse)).toEqual(t);
  expect(() => editTimeline(t, [{ type: "lock", track: "caption", locked: true }, { ...op, tracks: [] }])).toThrow("Unlock");
  expect(editTimeline(t, [{ ...op, tracks: ["music"] }]).timeline.clips.find(c => c.track === "music" && c.start === 20)).toMatchObject({ sourceStart: 40 });
});

test("repeated splits of a linked take retain bounded stable IDs and matching source starts", () => {
  let t = withClips({ ...media("picture", 0, 150), linkId: "take" },
    { ...media("voice", 0, 150), track: "speech", linkId: "take" });
  let id = "picture";
  for (let frame = 10; frame <= 100; frame += 10) {
    const rightId = crypto.randomUUID();
    t = editTimeline(t, [{ type: "split", id, rightId, frame }]).timeline;
    id = rightId;
  }
  expect(t.clips).toHaveLength(22);
  expect(t.clips.filter(c => c.start === 100)).toMatchObject([{ sourceStart: 100 }, { sourceStart: 100 }]);
});

test("invalid source references, incompatible tracks, zero-length clips and negative linked moves fail", () => {
  const t = withClips({ ...media("v", 0, 30), linkId: "g" }, { ...title("t", 5, 10), linkId: "g" });
  expect(() => editTimeline(t, [{ type: "add", clip: { ...media("x", 40, 10), assetId: "foreign" } }])).toThrow();
  expect(() => editTimeline(t, [{ type: "move", id: "v", track: "title", start: 0 }])).toThrow();
  expect(() => editTimeline(t, [{ type: "trim", id: "t", edge: "right", frame: 5 }])).toThrow();
  expect(() => editTimeline(t, [{ type: "move", id: "t", start: 1 }])).toThrow();
});
