import { clipSchema, tracks, type Change, type Clip, type Timeline, type Track } from "./model";

export class EditError extends Error {}

const end = (clip: Clip) => clip.start + clip.duration;
const linked = (a: Clip, b: Clip) => a.id === b.id || (a.linkId !== null && a.linkId === b.linkId);

function slice(clip: Clip, from: number, to: number): Clip {
  const range = { start: from, duration: to - from };
  return clip.kind === "media"
    ? { ...clip, ...range, sourceStart: clip.sourceStart + from - clip.start }
    : { ...clip, ...range };
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
  const leftGroups = new Set(t.clips.filter(c => c.linkId && groups.has(c.linkId) && c.start < from).map(c => c.linkId));
  const clips: Clip[] = [];
  for (const c of t.clips) {
    if ((!chosen.has(c.track) && !(c.linkId && groups.has(c.linkId))) || end(c) <= from) {
      clips.push(c);
      continue;
    }
    unlocked(t, c.track);
    const tailLink = c.linkId && leftGroups.has(c.linkId) ? op.cutId + ":" + c.linkId : c.linkId;
    if (c.start >= to) {
      clips.push({ ...c, start: c.start - length, linkId: tailLink });
      continue;
    }
    if (c.start < from) clips.push(slice(c, c.start, from));
    if (end(c) > to) {
      const tail = slice(c, to, end(c));
      clips.push({ ...tail, start: from, linkId: tailLink, id: c.start < from ? op.cutId + ":" + c.id : c.id });
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
    selected.text = op.text;
    return;
  }
  if (op.type === "volume") {
    if (selected.kind !== "media") throw new EditError("Select a media clip to change volume.");
    selected.volume = op.volume;
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
  t.clips = t.clips.flatMap((c): Clip[] => {
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
        return from < to ? [slice(c, from, to)] : [];
      }
      case "split": {
        const linkId = c.linkId === null ? null : "split:" + op.rightId;
        if (end(c) <= op.frame) return [c];
        if (c.start >= op.frame) return [{ ...c, linkId }];
        const rightId = c.id === selected.id ? op.rightId : op.rightId + ":" + c.id;
        return [slice(c, c.start, op.frame), { ...slice(c, op.frame, end(c)), id: rightId, linkId }];
      }
    }
  });
}

export type Patch = { put: Clip[]; remove: string[]; lockedTracks: Track[] };

function difference(before: Timeline, after: Timeline): Patch {
  const old = new Map(before.clips.map(c => [c.id, c]));
  const next = new Set(after.clips.map(c => c.id));
  return {
    put: after.clips.filter(c => {
      const prior = old.get(c.id);
      return !prior || Object.entries(c).some(([key, value]) => Reflect.get(prior, key) !== value);
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
