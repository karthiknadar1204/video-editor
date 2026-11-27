"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import { Film } from "@editor/composition";
import { earthrise as film } from "@editor/timeline";
import { ExportButton } from "./export-button";

function timecode(frame: number) {
  const seconds = Math.floor(frame / film.fps);
  return [Math.floor(seconds / 60), seconds % 60].map((part) => String(part).padStart(2, "0")).join(":");
}

function FrameControls({ player }: { player: RefObject<PlayerRef | null> }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const ref = player.current;
    if (!ref) return;
    const sync = () => setFrame(ref.getCurrentFrame());
    ref.addEventListener("frameupdate", sync);
    return () => ref.removeEventListener("frameupdate", sync);
  }, [player]);

  function step(delta: number) {
    const ref = player.current;
    if (!ref) return;
    ref.pause();
    ref.seekTo(Math.max(0, Math.min(film.durationInFrames - 1, ref.getCurrentFrame() + delta)));
  }

  return <div className="viewer-footer">
    <span>Sequence preview</span>
    <div className="steps">
      <button aria-label="Previous frame" onClick={() => step(-1)} disabled={frame === 0}>‹</button>
      <span>Frame {frame}</span>
      <button aria-label="Next frame" onClick={() => step(1)} disabled={frame === film.durationInFrames - 1}>›</button>
    </div>
  </div>;
}

export default function Page() {
  const player = useRef<PlayerRef>(null);
  const cues = [
    { frame: film.clips[0].start, label: "Opening shot", detail: "Wide view", image: "opening" },
    { frame: film.clips[1].start, label: "Title in", detail: "Close view", image: "title" },
  ];

  function seek(frame: number) {
    player.current?.pause();
    player.current?.seekTo(frame);
  }

  return (
    <>
      <header className="topbar">
        <div className="brand"><span className="mark" aria-hidden="true">◩</span>Cutroom</div>
        <span className="divider" aria-hidden="true">/</span><a className="workspace project-nav" href="/projects">My projects</a>
        <ExportButton />
      </header>
      <main>
        <div className="heading">
          <div><p className="eyebrow">Apollo 8 <span> / </span> December 1968</p><h1>{film.name}</h1></div>
          <span className="format">{film.width} × {film.height} <b>·</b> {film.fps} fps</span>
        </div>
        <div className="desk">
          <section className="viewer" aria-label="Sequence preview">
            <Player
              ref={player}
              component={Film}
              inputProps={{ timeline: film }}
              compositionWidth={film.width}
              compositionHeight={film.height}
              durationInFrames={film.durationInFrames}
              fps={film.fps}
              controls
              clickToPlay
              style={{ width: "100%", aspectRatio: "16 / 9" }}
            />
            <FrameControls player={player} />
          </section>
          <aside>
            <section>
              <h2>Cue points</h2>
              <div className="cues">{cues.map((cue) => (
                <button key={cue.frame} onClick={() => seek(cue.frame)}>
                  <img src={"/media/" + cue.image + ".jpg"} width="64" height="40" alt="" />
                  <span><strong>{cue.label}</strong><small>{cue.detail}</small></span>
                  <time>{timecode(cue.frame)}</time>
                </button>
              ))}</div>
            </section>
            <section className="source">
              <h2>Source</h2>
              <p>Bill Anders photographed Earth from lunar orbit on December 24, 1968. The audio is from the crew’s onboard recording.</p>
              <a href="https://science.nasa.gov/resource/apollo-8s-iconic-earthrise/" target="_blank" rel="noreferrer">NASA archive <span aria-hidden="true">↗</span></a>
            </section>
          </aside>
        </div>
      </main>
    </>
  );
}
