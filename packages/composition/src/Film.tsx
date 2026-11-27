import { loadFont } from "@remotion/fonts";
import type { Clip, Timeline } from "@editor/timeline";
import { AbsoluteFill, Html5Audio, OffthreadVideo, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

if (typeof document !== "undefined") {
  void loadFont({ family: "Cutroom Inter", url: staticFile("fonts/inter-latin.woff2"), weight: "100 900" });
  void loadFont({ family: "Cutroom PT Serif", url: staticFile("fonts/pt-serif-latin-700-normal.woff2"), weight: "700" });
  void loadFont({ family: "Cutroom Plex Mono", url: staticFile("fonts/ibm-plex-mono-latin-600-normal.woff2"), weight: "600" });
}
const captionFonts = { sans: ["Cutroom Inter", 650], serif: ["Cutroom PT Serif", 700], mono: ["Cutroom Plex Mono", 600] } as const;

function Content({ clip, assets }: { clip: Clip; assets: Timeline["assets"] }) {
  const { width, height } = useVideoConfig();
  const frame = useCurrentFrame();
  if (clip.kind === "text") {
    if (clip.caption) {
      const cue = clip.caption;
      const [family, weight] = captionFonts[cue.font];
      return <div style={{ position: "absolute", left: clip.x, top: clip.y, width: Math.round(width * .88), textAlign: "center",
        fontFamily: family, color: clip.color, fontWeight: weight, fontSize: clip.fontSize, lineHeight: 1.23, overflowWrap: "anywhere" }}>
        {cue.words.length > 0 && <span style={{ background: "rgba(0,0,0,.78)", padding: "0.06em 0.20em", boxDecorationBreak: "clone",
          WebkitBoxDecorationBreak: "clone", borderRadius: ".13em" }}>{cue.words.map((word, i) =>
          <span key={i} style={{ color: cue.style === "highlight" && frame >= word.from && frame < word.to ? cue.highlightColor : clip.color }}>
            {i ? " " : ""}{word.text}</span>)}</span>}
      </div>;
    }
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
