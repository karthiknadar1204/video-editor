import { clipSchema, tracks, type Change, type Clip, type Timeline, type Track } from "./model";

export class EditError extends Error {}

const end = (clip: Clip) => clip.start + clip.duration;
const linked = (a: Clip, b: Clip) => a.id === b.id || (a.linkId !== null && a.linkId === b.linkId);

// Use the operation ID and the original clip index so repeated cuts never grow IDs recursively.
function partId(operationId: string, kind: "clip" | "group", index: number) {
  return operationId.slice(0, 180) + ":" + kind + ":" + index;
}

export function sliceClip(clip: Clip, from: number, to: number): Clip {
  const range = { start: from, duration: to - from };
  if (clip.kind === "media") return { ...clip, ...range, sourceStart: clip.sourceStart + from - clip.start };
  if (!clip.caption) return { ...clip, ...range };
  const offset = from - clip.start;
  const words = clip.caption.words.flatMap(word => {
    const first = Math.max(0, word.from - offset), last = Math.min(range.duration, word.to - offset);
    return first < last ? [{ ...word, from: first, to: last }] : [];
  });
  return { ...clip, ...range, text: words.map(w => w.text).join(" ") || clip.text, caption: { ...clip.caption, words } };
}

function finish(t: Timeline): Timeline {
  const ids = new Set<string>();
  const lastEnd = new Map<Track, number>();
  t.clips.sort((a, b) => tracks.indexOf(a.track) - tracks.indexOf(b.track) || a.start - b.start || a.id.localeCompare(b.id));
  let duration = 0;
  for (const c of t.clips) {
    if (!clipSchema.safeParse(c).success) throw new EditError("Check clip frames, track and properties.");
    if (ids.has(c.id)) throw new EditError("Clip IDs must be unique.");
    ids.add(c.id);
    if (c.track === "music" && c.linkId) throw new EditError("Music is anchored independently.");
    if ((lastEnd.get(c.track) ?? 0) > c.start) throw new EditError("Clips on the same track cannot overlap.");
    if (c.kind === "media") {
      const asset = t.assets.find(a => a.id === c.assetId);
      if (!asset || c.sourceStart + c.duration > asset.duration) throw new EditError("Clip exceeds its source or references an unavailable asset.");
      if (asset.metadata && (c.track === "video" ? asset.metadata.mediaType === "audio" : !asset.metadata.hasAudio)) {
        throw new EditError("Choose a track that matches the streams in this asset.");
      }
    }
    lastEnd.set(c.track, end(c));
    duration = Math.max(duration, end(c));
  }
  if (duration > 300 * t.fps) throw new EditError("A project can run up to five minutes.");
  return { ...t, durationInFrames: duration };
}

function unlocked(t: Timeline, track: Track) {
  if (t.lockedTracks.includes(track)) throw new EditError("Unlock the " + track + " track first.");
}

// Removing [from, to) cuts through clips on the selected tracks, including clips spanning both edges.
function ripple(t: Timeline, selected: Clip, op: Extract<Change, { type: "rippleDelete" }>) {
  const from = selected.start, to = end(selected), length = selected.duration;
  const chosen = new Set([selected.track, ...op.tracks]);
  const groups = new Set(t.clips.filter(c => chosen.has(c.track) && end(c) > from && c.linkId).map(c => c.linkId));
  const rightGroups = new Map<string, string>();
  for (const [index, c] of t.clips.entries()) {
    if (c.linkId && groups.has(c.linkId) && c.start < from && !rightGroups.has(c.linkId)) {
      rightGroups.set(c.linkId, partId(op.cutId, "group", index));
    }
  }
  const clips: Clip[] = [];
  for (const [index, c] of t.clips.entries()) {
    if ((!chosen.has(c.track) && !(c.linkId && groups.has(c.linkId))) || end(c) <= from) {
      clips.push(c);
      continue;
    }
    unlocked(t, c.track);
    const tailLink = c.linkId && (rightGroups.get(c.linkId) ?? c.linkId);
    if (c.start >= to) {
      clips.push({ ...c, start: c.start - length, linkId: tailLink });
      continue;
    }
    if (c.start < from) clips.push(sliceClip(c, c.start, from));
    if (end(c) > to) {
      const tail = sliceClip(c, to, end(c));
      clips.push({ ...tail, start: from, linkId: tailLink, id: c.start < from ? partId(op.cutId, "clip", index) : c.id });
    }
  }
  t.clips = clips;
}

function apply(t: Timeline, op: Change) {
  if (op.type === "lock") {
    t.lockedTracks = tracks.filter(track => track === op.track ? op.locked : t.lockedTracks.includes(track));
    return;
  }
  if (op.type === "add") {
    unlocked(t, op.clip.track);
    if (t.clips.some(c => c.id === op.clip.id)) throw new EditError("Clip ID already exists.");
    t.clips.push({ ...op.clip });
    return;
  }
  if (op.type === "roughCut" || op.type === "restorePassage") {
    const changed = new Set([...op.remove, ...op.put.map(c => c.id)]);
    for (const c of t.clips) if (changed.has(c.id)) unlocked(t, c.track);
    for (const c of op.put) unlocked(t, c.track);
    t.clips = [...t.clips.filter(c => !changed.has(c.id)), ...op.put];
    return;
  }
  if (op.type === "link") {
    const members = op.ids.map(id => t.clips.find(c => c.id === id));
    if (new Set(op.ids).size < 2 || members.some(c => !c || c.track === "music")) throw new EditError("Select at least two linkable clips.");
    for (const c of t.clips) {
      if (op.ids.includes(c.id)) { unlocked(t, c.track); c.linkId = op.linkId; }
    }
    return;
  }
  const selected = t.clips.find(c => c.id === op.id);
  if (!selected) throw new EditError("The selected clip no longer exists.");
  unlocked(t, selected.track);
  if (op.type === "rippleDelete") return ripple(t, selected, op);
  if (op.type === "text") {
    if (selected.kind !== "text") throw new EditError("Select a title or caption to change text.");
    if (op.text !== selected.text) { selected.text = op.text; delete selected.caption; }
    return;
  }
  if (op.type === "volume") {
    if (selected.kind !== "media") throw new EditError("Select a media clip to change volume.");
    selected.volume = op.volume;
    return;
  }
  if (op.type === "framing") {
    if (selected.kind !== "media" || selected.track !== "video") throw new EditError("Select a video clip to adjust framing.");
    selected.fit = op.fit; selected.rotation = op.rotation;
    return;
  }
  if (op.type === "textStyle") {
    if (selected.kind !== "text") throw new EditError("Select a title or caption to change its style.");
    selected.fontSize = op.fontSize; selected.color = op.color;
    return;
  }
  if (op.type === "position") {
    if (selected.track === "speech" || selected.track === "music") throw new EditError("Select a visual clip to position.");
    selected.x = op.x; selected.y = op.y;
    return;
  }
  const oldStart = selected.start, oldEnd = end(selected);
  if (op.type === "split" && (op.frame <= oldStart || op.frame >= oldEnd)) throw new EditError("Split inside the selected clip.");
  if (op.type === "trim" && (op.edge === "left" ? op.frame >= oldEnd : op.frame <= oldStart)) throw new EditError("Keep at least one frame.");
  t.clips = t.clips.flatMap((c, index): Clip[] => {
    if (!linked(selected, c)) return [c];
    unlocked(t, c.track);
    switch (op.type) {
      case "delete": return [];
      case "move": {
        const track = c.id === selected.id && op.track ? op.track : c.track;
        unlocked(t, track);
        const result = clipSchema.safeParse({ ...c, track, start: c.start + op.start - oldStart });
        if (!result.success) throw new EditError("Choose a compatible track and a nonnegative start.");
        return [result.data];
      }
      case "trim": {
        // A linked caption inside the shot keeps its own boundaries until a trim reaches it.
        const from = op.edge === "left" ? (c.start === oldStart ? op.frame : Math.max(c.start, op.frame)) : c.start;
        const to = op.edge === "right" ? (end(c) === oldEnd ? op.frame : Math.min(end(c), op.frame)) : end(c);
        return from < to ? [sliceClip(c, from, to)] : [];
      }
      case "split": {
        const linkId = c.linkId === null ? null : partId(op.rightId, "group", 0);
        if (end(c) <= op.frame) return [c];
        if (c.start >= op.frame) return [{ ...c, linkId }];
        const rightId = c.id === selected.id ? op.rightId : partId(op.rightId, "clip", index);
        return [sliceClip(c, c.start, op.frame), { ...sliceClip(c, op.frame, end(c)), id: rightId, linkId }];
      }
    }
  });
}

export type Patch = { put: Clip[]; remove: string[]; lockedTracks: Track[] };

export function sameClip(a: Clip, b: Clip) {
  return JSON.stringify(clipSchema.parse(a)) === JSON.stringify(clipSchema.parse(b));
}

function difference(before: Timeline, after: Timeline): Patch {
  const old = new Map(before.clips.map(c => [c.id, c]));
  const next = new Set(after.clips.map(c => c.id));
  return {
    put: after.clips.filter(c => {
      const prior = old.get(c.id);
      return !prior || !sameClip(prior, c);
    }),
    remove: before.clips.filter(c => !next.has(c.id)).map(c => c.id),
    lockedTracks: after.lockedTracks,
  };
}

export function applyPatch(t: Timeline, patch: Patch): Timeline {
  const replaced = new Set([...patch.remove, ...patch.put.map(c => c.id)]);
  return finish({ ...t, clips: [...t.clips.filter(c => !replaced.has(c.id)), ...patch.put], lockedTracks: patch.lockedTracks });
}

export function editTimeline(original: Timeline, operations: Change[]) {
  const draft = structuredClone(original);
  for (const op of operations) apply(draft, op);
  const timeline = finish(draft);
  const forward = difference(original, timeline), inverse = difference(timeline, original);
  if (!forward.put.length && !forward.remove.length && forward.lockedTracks.join() === inverse.lockedTracks.join()) throw new EditError("The timeline is already up to date.");
  const changed = [...forward.put, ...inverse.put];
  const affected = changed.length ? { from: Math.min(...changed.map(c => c.start)), to: Math.max(...changed.map(end)) } : null;
  return { timeline, forward, inverse, affected };
}
