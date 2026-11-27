import { mediaClip, textClip, tracks, type Change, type Clip, type Timeline, type Track } from "@editor/timeline";
import { useState, type FormEvent } from "react";

type Submit = (operations: Change[], selectId?: string) => void;
const number = (data: FormData, name: string) => Number(data.get(name));

function FrameInput({ label, name, value, min = 0 }: { label: string; name: string; value: number; min?: number }) {
  return <label>{label}<input type="number" name={name} defaultValue={value} min={min} step="1" required /></label>;
}

export function AddClip({ timeline, selected, submit }: { timeline: Timeline; selected?: Clip; submit: Submit }) {
  const [track, setTrack] = useState<Track>("video");
  const isText = track === "title" || track === "caption";
  const asset = timeline.assets[0];
  const start = Math.max(0, ...timeline.clips.filter(c => c.track === track).map(c => c.start + c.duration));

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const id = crypto.randomUUID();
    const start = number(data, "start"), duration = number(data, "duration");
    const clip: Clip = track === "title" || track === "caption"
      ? { ...textClip(id, String(data.get("text")), start, duration, timeline.height), track }
      : { ...mediaClip(id, String(data.get("asset")), start, duration), sourceStart: number(data, "sourceStart"), track };
    const operations: Change[] = [{ type: "add", clip }];
    if (selected && data.has("linked")) operations.push({ type: "link", ids: [selected.id, id], linkId: selected.linkId ?? crypto.randomUUID() });
    submit(operations, id);
  }

  return <form onSubmit={add} className="clip-fields">
    <label>Track<select value={track} onChange={e => setTrack(e.target.value as Track)}>{tracks.map(t => <option key={t}>{t}</option>)}</select></label>
    {isText ? <label>Clip text<input name="text" required maxLength={2000} placeholder="Enter text" /></label>
      : <label>Source<select name="asset" defaultValue={asset?.id}>{timeline.assets.map(a =>
        <option key={a.id} value={a.id}>{a.name} · {a.duration} frames</option>)}</select></label>}
    <div className="field-pair" key={track}>
      <FrameInput label="Timeline start" name="start" value={start} />
      <FrameInput label="Duration (frames)" name="duration" value={timeline.fps * 3} min={1} />
    </div>
    {!isText && <FrameInput label="Source start" name="sourceStart" value={0} />}
    {selected && selected.track !== "music" && track !== "music" && <label className="tick"><input type="checkbox" name="linked" />Link to selected clip</label>}
    <button className="action" type="submit">Insert clip</button>
  </form>;
}

export function EditClip({ clip, playhead, submit }: { clip: Clip; playhead: number; submit: Submit }) {
  const [action, setAction] = useState("properties");
  const end = clip.start + clip.duration;
  function edit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget), id = clip.id;
    let ops: Change[] = [];
    switch (action) {
      case "properties": {
        if (clip.kind === "text" && data.get("text") !== clip.text) ops.push({ type: "text", id, text: String(data.get("text")) });
        if (data.has("x") && (number(data, "x") !== clip.x || number(data, "y") !== clip.y)) {
          ops.push({ type: "position", id, x: number(data, "x"), y: number(data, "y") });
        }
        if (clip.kind === "media" && number(data, "volume") !== clip.volume) ops.push({ type: "volume", id, volume: number(data, "volume") });
        break;
      }
      case "move": ops = [{ type: "move", id, start: number(data, "frame"), track: data.get("track") as Track }]; break;
      case "left": case "right": ops = [{ type: "trim", id, edge: action, frame: number(data, "frame") }]; break;
      case "split": {
        const rightId = crypto.randomUUID();
        submit([{ type: "split", id, frame: number(data, "frame"), rightId }], rightId);
        return;
      }
      case "delete": ops = [{ type: "delete", id }]; break;
      case "ripple": ops = [{ type: "rippleDelete", id, cutId: crypto.randomUUID(), tracks: tracks.filter(t => data.has(t)) }]; break;
    }
    if (ops.length) submit(ops);
  }

  const frame = action === "split" ? playhead : action === "right" ? end : clip.start;
  return <form onSubmit={edit} className="clip-fields">
    <p className="clip-meta">Frames {clip.start}–{end - 1} · {clip.duration} frames{clip.kind === "media" && <> · Source {clip.sourceStart}–{clip.sourceStart + clip.duration - 1}</>}{clip.linkId && " · Linked"}</p>
    <label>Action<select value={action} onChange={e => setAction(e.target.value)}>
      <option value="properties">Edit properties</option><option value="move">Move</option>
      <option value="left">Trim start</option><option value="right">Trim end</option><option value="split">Split</option>
      <option value="delete">Delete</option><option value="ripple">Ripple delete</option>
    </select></label>
    {action === "properties" && <>
      {clip.kind === "text" && <label>Clip text<input name="text" required maxLength={2000} defaultValue={clip.text} /></label>}
      {clip.track !== "speech" && clip.track !== "music" && <div className="field-pair">
        <FrameInput label="X position" name="x" value={clip.x} min={-10000} /><FrameInput label="Y position" name="y" value={clip.y} min={-10000} />
      </div>}
      {clip.kind === "media" && <label>Volume<input type="number" name="volume" min="0" max="1" step="any" required defaultValue={clip.volume} /></label>}
    </>}
    {action === "move" && <label>Destination track<select name="track" defaultValue={clip.track}>
      {(clip.kind === "media" ? ["video", "speech", "music"] : ["title", "caption"]).map(t => <option key={t}>{t}</option>)}
    </select></label>}
    {["move", "left", "right", "split"].includes(action) && <FrameInput key={action} label={action === "right" ? "End frame (exclusive)" : "Timeline frame"} name="frame" value={frame} />}
    {action === "ripple" && <fieldset className="ripple-tracks"><legend>Close gap on tracks</legend>{tracks.map(t =>
      <label key={t} className="tick"><input type="checkbox" name={t} defaultChecked={t === clip.track || t !== "music"} disabled={t === clip.track} />{t}</label>)}</fieldset>}
    <button className="action" type="submit">{action === "properties" ? "Save properties" : action === "split" ? "Split clip" : action === "ripple" ? "Ripple delete clip" : action === "delete" ? "Delete clip" : "Apply edit"}</button>
  </form>;
}
