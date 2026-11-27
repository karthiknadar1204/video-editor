import { fitSchema, mediaClip, rotationSchema, textClip, tracks, trackSchema, type Change, type Clip, type Timeline, type Track } from "@editor/timeline";
import { useState, type FormEvent } from "react";

type Submit = (operations: Change[], selectId?: string) => void;
const number = (data: FormData, name: string) => Number(data.get(name));

function FrameInput({ label, name, value, min = 0 }: { label: string; name: string; value: number; min?: number }) {
  return <label>{label}<input type="number" name={name} defaultValue={value} min={min} step="1" required /></label>;
}

export function AddClip({ timeline, selected, submit }: { timeline: Timeline; selected?: Clip; submit: Submit }) {
  const [track, setTrack] = useState<Track>("video");
  const [source, setSource] = useState("");
  const isText = track === "title" || track === "caption";
  const sources = timeline.assets.filter(a => !a.metadata || (track === "video" ? a.metadata.mediaType === "video" : a.metadata.hasAudio));
  const asset = sources.find(a => a.id === source) ?? sources[0];
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
    <label>Track<select value={track} onChange={e => setTrack(trackSchema.parse(e.target.value))}>{tracks.map(t => <option key={t}>{t}</option>)}</select></label>
    {isText ? <label>Clip text<input name="text" required maxLength={2000} placeholder="Enter text" /></label>
      : <label>Source<select name="asset" value={asset?.id ?? ""} onChange={e => setSource(e.target.value)} required>{sources.map(a =>
        <option key={a.id} value={a.id}>{a.name} · {a.duration} frames</option>)}</select></label>}
    <div className="field-pair" key={track}>
      <FrameInput label="Timeline start" name="start" value={start} />
      <FrameInput key={asset?.id} label="Duration (frames)" name="duration" value={isText ? timeline.fps * 3 : Math.min(timeline.fps * 3, asset?.duration ?? 1)} min={1} />
    </div>
    {!isText && <FrameInput label="Source start" name="sourceStart" value={0} />}
    {selected && selected.track !== "music" && track !== "music" && <label className="tick"><input type="checkbox" name="linked" />Link to selected clip</label>}
    <button className="action" type="submit" disabled={!isText && !asset}>Insert clip</button>
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
        if (clip.kind === "media" && clip.track === "video") {
          const fit = fitSchema.parse(data.get("fit")), rotation = rotationSchema.parse(number(data, "rotation"));
          if (fit !== (clip.fit ?? "cover") || rotation !== (clip.rotation ?? 0)) ops.push({ type: "framing", id, fit, rotation });
        }
        if (clip.kind === "text") {
          const fontSize = number(data, "fontSize"), color = String(data.get("color"));
          if (fontSize !== clip.fontSize || color !== clip.color.toLowerCase()) ops.push({ type: "textStyle", id, fontSize, color });
        }
        break;
      }
      case "move": ops = [{ type: "move", id, start: number(data, "frame"), track: trackSchema.parse(data.get("track")) }]; break;
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
      {clip.kind === "text" && <div className="field-pair">
        <label>Font size<input type="number" name="fontSize" min={8} max={400} step={1} required defaultValue={clip.fontSize} /></label>
        <label>Text color<input type="color" name="color" defaultValue={clip.color} /></label>
      </div>}
      {clip.kind === "media" && clip.track === "video" && <div className="field-pair">
        <label>Canvas fit<select name="fit" defaultValue={clip.fit ?? "cover"}><option value="cover">Fill canvas</option><option value="contain">Fit inside</option></select></label>
        <label>Rotation<select name="rotation" defaultValue={clip.rotation ?? 0}>{[0, 90, 180, 270].map(deg => <option key={deg} value={deg}>{deg}°</option>)}</select></label>
      </div>}
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
