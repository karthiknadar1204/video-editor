import { loadFont } from "@remotion/fonts";
import type { Timeline } from "@editor/timeline";
import { AbsoluteFill, OffthreadVideo, Sequence, staticFile } from "remotion";

if (typeof document !== "undefined") {
  void loadFont({
    family: "Cutroom Inter",
    url: staticFile("fonts/inter-latin.woff2"),
    weight: "100 900",
  });
}

export function Film({ timeline }: { timeline: Timeline }) {
  return (
    <AbsoluteFill style={{ backgroundColor: "#050505" }}>
      {timeline.videoTrack.map((clip) => (
        <Sequence key={clip.id} from={clip.start} durationInFrames={clip.duration}>
          <OffthreadVideo
            src={staticFile(clip.src)}
            trimBefore={clip.sourceStart}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        </Sequence>
      ))}
      {timeline.title && <Sequence from={timeline.title.start} durationInFrames={timeline.title.duration}>
        <div style={{
          position: "absolute", left: 68, bottom: 224, color: "white",
          fontFamily: '"Cutroom Inter", sans-serif', fontSize: 76,
          lineHeight: 1, fontWeight: 650, letterSpacing: "-0.06em",
          textShadow: "0 2px 12px rgba(0,0,0,.55)",
        }}>{timeline.title.text}</div>
      </Sequence>}
    </AbsoluteFill>
  );
}
