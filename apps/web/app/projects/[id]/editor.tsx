"use client";

import { Film } from "@editor/composition";
import { tracks, type Change, type Clip, type ProjectSnapshot } from "@editor/timeline";
import { Player, type PlayerRef } from "@remotion/player";
import { useEffect, useRef, useState } from "react";
import { AddClip, EditClip } from "./clip-form";
import { useTimeline } from "./use-timeline";
import "./editor.css";

export function Editor({ initial }: { initial: ProjectSnapshot }) {
  const { project, save, status, message, retry, reload, markDirty, formVersion } = useTimeline(initial);
  const { timeline, revision } = project;
  const { width, height, fps, durationInFrames: length } = timeline;
  const player = useRef<PlayerRef>(null);
  const [frame, setFrame] = useState(0);
  const [selectedId, select] = useState("");
  const [adding, setAdding] = useState(false);
  const selected = timeline.clips.find(c => c.id === selectedId);
  const addingClip = adding || !selected;
  const editable = status === "ready";

  useEffect(() => {
    const ref = player.current;
    if (!ref) return;
    if (ref.getCurrentFrame() >= length) ref.seekTo(Math.max(0, length - 1));
    const sync = () => setFrame(ref.getCurrentFrame());
    sync();
    ref.addEventListener("frameupdate", sync);
    return () => ref.removeEventListener("frameupdate", sync);
  }, [length]);

  function seek(value: number) {
    if (!Number.isFinite(value)) return;
    player.current?.pause();
    player.current?.seekTo(Math.max(0, Math.min(length - 1, Math.round(value))));
  }
  function name(clip: Clip) {
    return clip.kind === "text" ? clip.text : timeline.assets.find(a => a.id === clip.assetId)?.name ?? clip.assetId;
  }
  async function submit(ops: Change[], nextId?: string) {
    if (await save(ops)) {
      if (nextId) select(nextId);
      setAdding(false);
    }
  }
  const canvas = { aspectRatio: width / height, width: "min(100%, " + width / height * 44 + "vh)" };

  return <main className="project-editor">
    <div className="heading"><h1>{project.title}</h1><span className="format">{width} × {height} · {fps} fps</span></div>
    <div className="editor-workspace">
      <section className="editor-preview" aria-label="Project preview">
        <div className="monitor">
          {length > 0 ? <Player ref={player} component={Film} inputProps={{ timeline }}
            compositionWidth={width} compositionHeight={height} fps={fps} durationInFrames={length}
            controls clickToPlay style={canvas} /> : <div className="empty-monitor" style={canvas}>No clips yet</div>}
        </div>
        <div className="viewer-footer"><label>Playhead frame <input aria-label="Playhead frame" type="number" min="0" max={Math.max(0, length - 1)}
          disabled={!length} value={length ? frame : 0} onChange={e => seek(e.currentTarget.valueAsNumber)} /></label>
          <span>{length} frames</span></div>
      </section>
      <section className="inspector" aria-label="Clip inspector">
        <div className="editor-toolbar"><h2>{addingClip ? "Add clip" : "Selected clip"}</h2>
          {selected && <button disabled={!editable} onClick={() => setAdding(!adding)}>{adding ? "Back to clip" : "Add clip"}</button>}
        </div>
        <fieldset key={[formVersion, revision, selectedId, addingClip].join("/")} disabled={!editable} className="form-wrap" onChange={markDirty}>
          {addingClip ? <AddClip timeline={timeline} selected={selected} submit={submit} />
            : <EditClip clip={selected} playhead={frame} submit={submit} />}
        </fieldset>
      </section>
    </div>
    <section className="cut-timeline" aria-label="Timeline">
      <div className="editor-toolbar"><h2>Timeline</h2><div className="history-buttons">
        <button disabled={!editable || !project.canUndo} onClick={() => void save("undo")}>Undo</button>
        <button disabled={!editable || !project.canRedo} onClick={() => void save("redo")}>Redo</button></div>
      </div>
      <div className="edit-status" role="status">
        <span>Revision {revision}</span>
        {status === "opening" && <span>Opening editor…</span>}
        {status === "saving" && <span>Saving…</span>}
        {status === "conflict" ? <><span>Another edit was saved. Load the latest revision to continue.</span><button onClick={() => void reload()}>Load latest</button></> :
          message && <span>{message}</span>}
        {status === "retry" && <button onClick={() => void retry()}>Retry save</button>}
      </div>
      {tracks.map(track => {
        const locked = timeline.lockedTracks.includes(track);
        return <div className="track-row" key={track}>
          <div className="lane-label"><strong>{track}</strong><button aria-label={(locked ? "Unlock " : "Lock ") + track + " track"}
            aria-pressed={locked} disabled={!editable} onClick={() => void save([{ type: "lock", track, locked: !locked }])}>{locked ? "Locked" : "Lock"}</button></div>
          <div className="lane" role="group" aria-label={track + " clips"}>{timeline.clips.filter(c => c.track === track).map(c =>
            <button key={c.id} aria-label={name(c) + " at frame " + c.start} aria-pressed={c.id === selectedId} disabled={!editable}
              style={{ left: c.start / length * 100 + "%", width: c.duration / length * 100 + "%" }}
              onClick={() => { select(c.id); setAdding(false); seek(c.start); }}>{name(c)}</button>)}
          </div>
        </div>;
      })}
    </section>
  </main>;
}
