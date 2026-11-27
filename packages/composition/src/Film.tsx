import { loadFont } from "@remotion/fonts";
import type { Clip, Timeline } from "@editor/timeline";
import { AbsoluteFill, Html5Audio, OffthreadVideo, Sequence, staticFile, useVideoConfig } from "remotion";

if (typeof document !== "undefined") {
  void loadFont({ family: "Cutroom Inter", url: staticFile("fonts/inter-latin.woff2"), weight: "100 900" });
}

function Content({ clip, assets }: { clip: Clip; assets: Timeline["assets"] }) {
  const { width, height } = useVideoConfig();
  if (clip.kind === "text") {
    return <div style={{ position: "absolute", left: clip.x, top: clip.y, color: clip.color,
      fontFamily: '"Cutroom Inter", sans-serif', fontSize: clip.fontSize, lineHeight: 1, fontWeight: 650,
      letterSpacing: "-0.06em", textShadow: "0 2px 12px rgba(0,0,0,.55)", whiteSpace: "pre-wrap" }}>{clip.text}</div>;
  }
  const asset = assets.find(a => a.id === clip.assetId);
  if (!asset) throw new Error("Missing asset for clip " + clip.id);
  const props = { src: asset.src.startsWith("/api/") ? asset.src : staticFile(asset.src), trimBefore: clip.sourceStart, volume: clip.volume };
  if (clip.track !== "video") return <Html5Audio {...props} />;
  const turn = clip.rotation ?? 0;
  const sideways = turn === 90 || turn === 270;
  const w = sideways ? height : width, h = sideways ? width : height;
  return <OffthreadVideo {...props} style={{ position: "absolute", left: clip.x + (width - w) / 2, top: clip.y + (height - h) / 2,
    width: w, height: h, objectFit: clip.fit ?? "cover", transform: turn ? "rotate(" + turn + "deg)" : undefined }} />;
}

export function Film({ timeline }: { timeline: Timeline }) {
  return <AbsoluteFill style={{ backgroundColor: "#050505", overflow: "hidden" }}>
    {timeline.clips.map(clip => <Sequence key={clip.id} from={clip.start} durationInFrames={clip.duration}>
      <Content clip={clip} assets={timeline.assets} />
    </Sequence>)}
  </AbsoluteFill>;
}
