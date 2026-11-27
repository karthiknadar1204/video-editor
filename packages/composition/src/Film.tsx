import { loadFont } from "@remotion/fonts";
import type { Clip, Timeline } from "@editor/timeline";
import { AbsoluteFill, Html5Audio, OffthreadVideo, Sequence, staticFile } from "remotion";

if (typeof document !== "undefined") {
  void loadFont({ family: "Cutroom Inter", url: staticFile("fonts/inter-latin.woff2"), weight: "100 900" });
}

function Content({ clip, assets }: { clip: Clip; assets: Timeline["assets"] }) {
  if (clip.kind === "text") {
    return <div style={{ position: "absolute", left: clip.x, top: clip.y, color: clip.color,
      fontFamily: '"Cutroom Inter", sans-serif', fontSize: clip.fontSize, lineHeight: 1, fontWeight: 650,
      letterSpacing: "-0.06em", textShadow: "0 2px 12px rgba(0,0,0,.55)", whiteSpace: "pre-wrap" }}>{clip.text}</div>;
  }
  const asset = assets.find(a => a.id === clip.assetId);
  if (!asset) throw new Error("Missing asset for clip " + clip.id);
  const props = { src: staticFile(asset.src), trimBefore: clip.sourceStart, volume: clip.volume };
  if (clip.track !== "video") return <Html5Audio {...props} />;
  return <OffthreadVideo {...props} style={{ position: "absolute", left: clip.x, top: clip.y, width: "100%", height: "100%", objectFit: "cover" }} />;
}

export function Film({ timeline }: { timeline: Timeline }) {
  return <AbsoluteFill style={{ backgroundColor: "#050505", overflow: "hidden" }}>
    {timeline.clips.map(clip => <Sequence key={clip.id} from={clip.start} durationInFrames={clip.duration}>
      <Content clip={clip} assets={timeline.assets} />
    </Sequence>)}
  </AbsoluteFill>;
}
