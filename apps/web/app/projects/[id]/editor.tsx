"use client";

import { Film } from "@editor/composition";
import { mediaClip, type Change, type ProjectSnapshot, type Timeline } from "@editor/timeline";
import { Player, type PlayerRef } from "@remotion/player";
import { useEffect, useRef, useState } from "react";
import { ExportButton } from "../../export-button";
import { AssistantPanel } from "./assistant-panel";
import { CodexConnect } from "./codex-connect";
import { AddClip, EditClip } from "./clip-form";
import { MediaLibrary } from "./media-library";
import { RoughCutReview } from "./rough-cut-review";
import { TimelinePanel } from "./timeline-panel";
import { useTimeline } from "./use-timeline";
import "./editor.css";

function timecode(frame: number, fps: number) {
  const seconds = Math.floor(frame / fps);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60, frame % fps]
    .map(n => String(n).padStart(2, "0")).join(":");
}

export function Editor({ initial }: { initial: ProjectSnapshot }) {
  const { project, save, status, message, retry, reload, syncAssets, markDirty, clearDraft, formVersion, hasDraft, online } = useTimeline(initial);
  const { timeline, revision } = project;
  const { width, height, fps } = timeline;
  const [preview, setPreview] = useState<Timeline | null>(null);
  const shown = preview ?? timeline, length = shown.durationInFrames;
  const player = useRef<PlayerRef>(null);
  const stopAt = useRef<number | null>(null);
  const [frame, setFrame] = useState(0);
  const [selectedId, select] = useState("");
  const [adding, setAdding] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [connectOpen,setConnectOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState("timeline");
  const [safe, setSafe] = useState(false);
  const [large, setLarge] = useState(false);
  const [draftVersion, resetForm] = useState(0);
  const selected = timeline.clips.find(c => c.id === selectedId);
  const addingClip = adding || !selected;
  const editable = status === "ready";
  const saved = editable && online && !hasDraft && !preview;

  useEffect(() => {
    const ref = player.current;
    if (!ref) { setFrame(0); return; }
    if (ref.getCurrentFrame() >= length) ref.seekTo(Math.max(0, length - 1));
    const sync = () => {
      const at = ref.getCurrentFrame();
      setFrame(at);
      if (stopAt.current !== null && at >= stopAt.current) { stopAt.current = null; ref.pause(); }
    };
    sync();
    ref.addEventListener("frameupdate", sync);
    return () => ref.removeEventListener("frameupdate", sync);
  }, [length]);

  function seek(value: number) {
    if (!Number.isFinite(value)) return;
    stopAt.current = null;
    player.current?.pause();
    player.current?.seekTo(Math.max(0, Math.min(length - 1, Math.round(value))));
  }
  function playRecent() {
    const at = Math.min(length - 1, project.history.find(h => h.from !== null)?.from ?? selected?.start ?? 0);
    seek(at - fps);
    stopAt.current = Math.min(length - 1, at + fps * 3);
    player.current?.play();
  }
  function choose(id: string) {
    select(id); setAdding(false); clearDraft(); resetForm(n => n + 1);
  }
  async function submit(ops: Change[], nextId?: string) {
    if (!await save(ops)) return false;
    if (nextId) select(nextId);
    setAdding(false);
    return true;
  }
  async function insertAsset(asset: Timeline["assets"][number]) {
    const track = asset.metadata?.mediaType === "audio" ? "speech" : "video";
    const start = Math.max(0, ...timeline.clips.filter(c => c.track === track).map(c => c.start + c.duration));
    const id = crypto.randomUUID();
    const duration = Math.max(1, Math.min(asset.duration, fps * 300 - start));
    if (await submit([{ type: "add", clip: { ...mediaClip(id, asset.id, start, duration), track, fit: "contain" } }], id)) {
      setMediaOpen(false); setMobileTab("timeline"); seek(start);
    }
  }

  return <main className="project-editor" data-mobile-tab={mobileTab} onKeyDown={e => {
    if (!editable || hasDraft || e.altKey || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
    if (e.target instanceof HTMLElement && e.target.closest("input, select, textarea, [contenteditable=true], dialog")) return;
    if (e.shiftKey ? !project.canRedo : !project.canUndo) return;
    e.preventDefault();
    if (!e.repeat) void save(e.shiftKey ? "redo" : "undo");
  }}>
    <header className="project-bar"><div className="project-heading"><h1>{project.title}</h1>
      <span className="format">{width} × {height} · {fps} fps</span></div>
      <div className="project-actions"><details className="project-history"><summary>History</summary>
        <div><h2>Version history</h2>{project.history.length ? <ol>{project.history.map(h => <li key={h.revision}>
          <small>r{h.revision}</small>{h.from !== null ? <button onClick={() => seek(h.from!)}>{h.label}</button> : <span>{h.label}</span>}
        </li>)}</ol> : <p>No edits yet.</p>}</div></details>
        <button className="studio-subtle" onClick={() => setConnectOpen(true)}>Connect Codex</button>
        <button className="studio-subtle" disabled={!saved} onClick={() => setMediaOpen(true)}>Media library</button>
        <ExportButton project={{ id:project.id, revision }} disabled={!saved || length === 0} /></div>
    </header>
    <div className="edit-status" role="status"><span className="save-indicator" data-saved={editable && online && !hasDraft} />
      <span>Revision {revision}</span><span aria-hidden="true">·</span>
      {status === "conflict" ? <><span>Another edit was saved. Load the latest revision to continue.</span><button onClick={() => void reload()}>Load latest</button></> :
        <>{message || (status === "opening" ? "Opening editor…" : status === "saving" ? "Saving…" : [!online && "Offline", hasDraft && "Unsaved changes"].filter(Boolean).join(" · ") || "Saved")}
          {status === "retry" && <button onClick={() => void retry()}>Retry save</button>}
          {editable && hasDraft && <button onClick={() => { clearDraft(); resetForm(n => n + 1); }}>Discard draft</button>}</>}
      <RoughCutReview project={project} selected={selected} editable={saved} onChange={reload} />
    </div>
    <nav className="mobile-panels" aria-label="Studio panels">{["Timeline", "Assistant"].map(tab =>
      <button key={tab} aria-pressed={mobileTab === tab.toLowerCase()} onClick={() => setMobileTab(tab.toLowerCase())}>{tab}</button>)}</nav>
    <div className="editor-workspace">
      <AssistantPanel project={project} selected={selected} frame={frame} editable={saved} onApply={submit} />
      <section className="editor-preview studio-card" aria-label="Project preview">
        <div className="studio-panel-title"><h2>Preview</h2><div className="monitor-settings">
          <button aria-pressed={safe} onClick={() => setSafe(!safe)}>Safe zone</button>
          <button aria-label="Enlarge preview" aria-pressed={large} onClick={() => setLarge(!large)}>{large ? "Fit" : "Enlarge"}</button></div></div>
        <div className="monitor" data-large={large}>
          {length > 0 ? <div className="canvas-frame" style={{ aspectRatio: width / height, width: "min(100%, " + width / height * (large ? 62 : 37) + "vh)" }}>
            <Player ref={player} component={Film} inputProps={{ timeline:shown }} compositionWidth={width} compositionHeight={height}
              fps={fps} durationInFrames={length} controls clickToPlay style={{ width:"100%", height:"100%" }} />
            {safe && <div className="safe-zone" aria-label="Caption safe zone" />}</div> :
            <div className="empty-monitor"><span className="empty-film" aria-hidden="true">▷</span><h3>No clips yet</h3>
              <button className="studio-primary" disabled={!saved} onClick={() => setMediaOpen(true)}>Add footage</button>
              {timeline.assets[0] && <button className="sample-insert" disabled={!saved} onClick={() => void insertAsset(timeline.assets[0])}>Use sample footage</button>}</div>}
        </div>
        <div className="transport"><div className="playback-time"><time>{timecode(frame, fps)}</time><small> / {timecode(length, fps)}</small></div>
          <div className="step-controls"><button aria-label="Previous frame" disabled={!frame} onClick={() => seek(frame - 1)}>‹</button>
            <label><span className="studio-sr">Playhead frame</span><input aria-label="Playhead frame" type="number" min="0" max={Math.max(0, length - 1)}
              disabled={!length} value={length ? frame : 0} onChange={e => seek(e.currentTarget.valueAsNumber)} /></label>
            <button aria-label="Next frame" disabled={frame >= length - 1} onClick={() => seek(frame + 1)}>›</button></div>
          <button className="play-changes" disabled={!length} onClick={playRecent}>Play changes</button></div>
      </section>
      <section className="inspector studio-card" aria-label="Clip inspector">
        <div className="studio-panel-title"><h2>{addingClip ? "Add clip" : "Selected clip"}</h2>
          {selected && <button disabled={!editable} onClick={() => { clearDraft(); setAdding(!adding); }}>{adding ? "Back to clip" : "Add clip"}</button>}</div>
        <fieldset key={[formVersion, draftVersion, revision, selectedId, addingClip].join("/")} disabled={!editable} className="form-wrap" onChange={markDirty}>
          {addingClip ? <AddClip timeline={timeline} selected={selected} submit={submit} /> : <EditClip clip={selected} playhead={frame} submit={submit} />}
        </fieldset>
      </section>
    </div>
    <TimelinePanel timeline={timeline} revision={revision} frame={frame} selectedId={selectedId} editable={editable}
      onSelect={choose} onSeek={seek} onEdit={ops => void submit(ops)} onPreview={setPreview}
      toolbar={<div className="history-buttons"><button disabled={!editable || !project.canUndo} onClick={() => void save("undo")}>Undo</button>
        <button disabled={!editable || !project.canRedo} onClick={() => void save("redo")}>Redo</button></div>} />
    {mediaOpen && <MediaLibrary id={project.id} timeline={timeline} revision={revision} onAdded={syncAssets} onInsert={insertAsset}
      onJump={(id, at) => { choose(id); seek(at); setMediaOpen(false); setMobileTab("timeline"); }} close={() => setMediaOpen(false)} />}
    {connectOpen && <CodexConnect id={project.id} close={()=>setConnectOpen(false)} />}
  </main>;
}
