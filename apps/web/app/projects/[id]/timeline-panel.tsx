import { EditError, editTimeline, tracks, trackSchema, type Change, type Clip, type Timeline } from "@editor/timeline";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import "./timeline-panel.css";

type Props = {
  timeline: Timeline;
  revision: number;
  frame: number;
  selectedId: string;
  editable: boolean;
  onSelect: (id: string) => void;
  onSeek: (frame: number) => void;
  onEdit: (operations: Change[]) => void;
  onPreview: (timeline: Timeline | null) => void;
  toolbar?: ReactNode;
};

type Gesture = {
  clip: Clip; edge: "move" | "left" | "right"; revision: number; x: number; y: number;
  pointer: number; scale: number; anchors: number[]; change?: Change;
};

const trackGlyph = { video: "▶", speech: "≋", music: "♫", title: "T", caption: "CC" };

function timeLabel(frame: number, fps: number) {
  const seconds = Math.floor(frame / fps);
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}

function snapFrame(value: number, anchors: number[], edges: number[], tolerance: number) {
  let result = value, closest = tolerance;
  for (const anchor of anchors) {
    for (const edge of edges) {
      const distance = anchor - (value + edge);
      if (Math.abs(distance) < closest) { result = value + distance; closest = Math.abs(distance); }
    }
  }
  return result;
}

export function TimelinePanel({ timeline, revision, frame, selectedId, editable, onSelect, onSeek, onEdit, onPreview, toolbar }: Props) {
  const [zoom, setZoom] = useState(1);
  const [snap, setSnap] = useState(true);
  const [width, setWidth] = useState(640);
  const [draft, setDraft] = useState<Timeline | null>(null);
  const [hint, setHint] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const { fps } = timeline;
  const shown = draft ?? timeline;
  const extent = Math.min(fps * 300, Math.max(fps * 6, timeline.durationInFrames + fps * 2));
  const plotWidth = Math.max(1, width * zoom);
  const rawTick = extent * 76 / plotWidth / fps;
  const tick = (rawTick > 1 ? Math.ceil(rawTick) * fps : Math.max(1, Math.round(fps / Math.max(1, Math.floor(1 / rawTick)))));
  const tickCount = Math.ceil(extent / tick);

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const observer = new ResizeObserver(() => { if (el.clientWidth) setWidth(el.clientWidth); });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = viewport.current;
    if (!el || gesture.current) return;
    const at = frame / extent * plotWidth;
    if (at < el.scrollLeft || at > el.scrollLeft + el.clientWidth) el.scrollLeft = Math.max(0, at - el.clientWidth / 3);
  }, [frame, extent, plotWidth]);

  useEffect(() => {
    if (gesture.current && (gesture.current.revision !== revision || !editable)) {
      gesture.current = null;
      setDraft(null);
      onPreview(null);
      setHint("The timeline changed. Start the drag again.");
    }
  }, [revision, editable, onPreview]);

  useEffect(() => () => onPreview(null), [onPreview]);

  function cancel() {
    gesture.current = null;
    setDraft(null);
    onPreview(null);
  }

  function begin(event: PointerEvent<HTMLButtonElement>, clip: Clip) {
    if (!event.isPrimary || event.button !== 0 || !surface.current) return;
    onSelect(clip.id);
    onSeek(clip.start);
    setHint("");
    if (!editable || timeline.lockedTracks.includes(clip.track)) return;
    const handle = event.target instanceof HTMLElement ? event.target.dataset.edge : undefined;
    gesture.current = {
      clip, edge: handle === "left" || handle === "right" ? handle : "move", revision,
      x: event.clientX, y: event.clientY, pointer: event.pointerId, scale: plotWidth / extent,
      anchors: [0, frame, ...timeline.clips.filter(c => c.id !== clip.id && (!clip.linkId || c.linkId !== clip.linkId))
        .flatMap(c => [c.start, c.start + c.duration])],
    };
    surface.current.setPointerCapture(event.pointerId);
  }

  function drag(event: PointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g || g.pointer !== event.pointerId || g.revision !== revision || !editable) return;
    const dx = event.clientX - g.x;
    if (!g.change && Math.abs(dx) < 3 && Math.abs(event.clientY - g.y) < 3) return;
    const { clip, edge } = g;
    const oldFrame = clip.start + (edge === "right" ? clip.duration : 0);
    const value = oldFrame + Math.round(dx / g.scale);
    const next = Math.max(0, snap ? snapFrame(value, g.anchors, edge === "move" ? [0, clip.duration] : [0], 6 / g.scale) : value);
    const lane = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-track]")?.dataset.track;
    const laneTrack = trackSchema.safeParse(lane);
    const track = laneTrack.success ? laneTrack.data : clip.track;
    const change: Change = edge === "move" ? { type: "move", id: clip.id, start: next, track } : { type: "trim", id: clip.id, edge, frame: next };
    try {
      const result = editTimeline(timeline, [change]).timeline;
      g.change = change;
      setDraft(result);
      onPreview(result);
      if (edge !== "move") onSeek(edge === "right" ? next - 1 : next);
      setHint((edge === "move" ? "Move to " : "Trim to ") + "frame " + next);
    } catch (error) {
      if (!(error instanceof EditError)) throw error;
      g.change = undefined;
      setDraft(null);
      onPreview(null);
      setHint(next === oldFrame && track === clip.track ? "" : error.message);
    }
  }

  function finish(event: PointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g || event.pointerId !== g.pointer) return;
    const change = g.change;
    cancel();
    if (change && g.revision === revision && editable) {
      setHint("");
      onEdit([change]);
    }
  }

  function keyEdit(event: KeyboardEvent<HTMLButtonElement>, clip: Clip) {
    if (event.key === "Escape" && gesture.current) { cancel(); setHint(""); return; }
    if (!editable || timeline.lockedTracks.includes(clip.track) || event.metaKey || event.ctrlKey) return;
    const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    let change: Change;
    if (delta && event.altKey) change = { type: "trim", id: clip.id, edge: "left", frame: Math.max(0, clip.start + delta) };
    else if (delta && event.shiftKey) change = { type: "trim", id: clip.id, edge: "right", frame: clip.start + clip.duration + delta };
    else if (delta) change = { type: "move", id: clip.id, start: Math.max(0, clip.start + delta) };
    else if (event.key === "Delete" || event.key === "Backspace") change = { type: "delete", id: clip.id };
    else return;
    event.preventDefault();
    if (event.repeat) return;
    onSelect(clip.id);
    onEdit([change]);
  }

  function seekRuler(clientX: number) {
    const el = surface.current;
    if (el) onSeek(Math.round((clientX - el.getBoundingClientRect().left) / plotWidth * extent));
  }

  return <section className="sequence-panel" aria-label="Timeline">
    <header className="sequence-head"><h2>Timeline</h2><span className="sequence-count">{shown.clips.length} {shown.clips.length === 1 ? "clip" : "clips"}</span>
      <div className="sequence-tools">{toolbar}
        <button type="button" className="sequence-snap" aria-pressed={snap} onClick={() => setSnap(!snap)} title="Snap edits to clip edges and the playhead">Snap</button>
        <div className="sequence-zoom"><button type="button" aria-label="Zoom out timeline" disabled={zoom === 1} onClick={() => setZoom(zoom / 2)}>−</button>
          <button type="button" aria-label="Fit timeline" onClick={() => setZoom(1)}>{zoom}×</button>
          <button type="button" aria-label="Zoom in timeline" disabled={zoom === 16} onClick={() => setZoom(zoom * 2)}>+</button></div>
      </div>
    </header>
    <div className="sequence-grid">
      <div className="sequence-keys"><div className="sequence-scale-label">TRACKS</div>
        {tracks.map(track => {
          const locked = timeline.lockedTracks.includes(track);
          return <div key={track} className={'sequence-key lane-' + track}>
            <span className="lane-type" aria-hidden="true">{trackGlyph[track]}</span><strong>{track}</strong>
            <button type="button" className="sequence-lock" aria-label={(locked ? "Unlock " : "Lock ") + track + " track"}
              aria-pressed={locked} disabled={!editable} onClick={() => onEdit([{ type: "lock", track, locked: !locked }])}><i aria-hidden="true" /></button>
          </div>;
        })}
      </div>
      <div ref={viewport} className="sequence-scroll">
        <div ref={surface} className="sequence-surface" style={{ width: zoom * 100 + "%" }}
          onPointerMove={drag} onPointerUp={finish} onPointerCancel={() => { cancel(); setHint(""); }}
          onLostPointerCapture={() => { if (gesture.current) cancel(); }}>
          <div className="sequence-ruler" role="slider" tabIndex={0} aria-label="Timeline playhead" aria-valuemin={0}
            aria-valuemax={Math.max(0, timeline.durationInFrames - 1)} aria-valuenow={frame} aria-valuetext={"Frame " + frame}
            onPointerDown={e => { if (e.button === 0) { e.currentTarget.setPointerCapture(e.pointerId); seekRuler(e.clientX); } }}
            onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) seekRuler(e.clientX); }}
            onKeyDown={e => {
              const step = e.shiftKey ? fps : 1;
              const keys: Record<string, number> = { ArrowLeft: frame - step, ArrowRight: frame + step, Home: 0, End: timeline.durationInFrames - 1 };
              if (e.key in keys) { e.preventDefault(); onSeek(keys[e.key]); }
            }}>
            {Array.from({ length: tickCount }, (_, i) => <span key={i} style={{ left: i * tick / extent * 100 + "%" }}>
              {tick < fps && (i * tick) % fps ? (i * tick) % fps + "f" : timeLabel(i * tick, fps)}</span>)}
          </div>
          {tracks.map(track => <div className={"sequence-lane lane-" + track} key={track} data-track={track} role="group" aria-label={track + " clips"}
            style={{ backgroundSize: tick / extent * 100 + "% 100%" }}>
            {shown.clips.filter(c => c.track === track).map(c => {
              const asset = c.kind === "media" ? timeline.assets.find(a => a.id === c.assetId) : undefined;
              const label = c.kind === "text" ? c.text : asset?.name ?? c.assetId;
              const thumbnail = asset?.metadata?.thumbnail ?? (asset?.id === "earthrise-rushes" || asset?.id === "earthrise" ? "/media/opening.jpg" : undefined);
              return <button type="button" key={c.id} className="sequence-clip" aria-label={label + " at frame " + c.start}
                aria-pressed={selectedId === c.id} aria-describedby="sequence-shortcuts" disabled={!editable}
                style={{ left: c.start / extent * 100 + "%", width: c.duration / extent * 100 + "%" }}
                onPointerDown={e => begin(e, c)} onClick={e => { if (e.detail === 0) { onSelect(c.id); onSeek(c.start); } }} onKeyDown={e => keyEdit(e, c)}>
                <span className="clip-handle" data-edge="left" title="Trim start" />
                {track === "video" && thumbnail && c.duration / extent * plotWidth >= 74 && <img className="clip-still" src={thumbnail} alt="" draggable={false} />}
                <span className="clip-label">{label}</span>
                <span className="clip-handle" data-edge="right" title="Trim end" /></button>;
            })}
          </div>)}
          <div className="sequence-playhead" aria-hidden="true" style={{ left: frame / extent * 100 + "%" }} />
        </div>
      </div>
    </div>
    <p className="sequence-shortcuts" id="sequence-shortcuts" aria-live="polite">
      {hint || "← → move · Alt + arrows trim start · Shift + arrows trim end"}
    </p>
  </section>;
}
