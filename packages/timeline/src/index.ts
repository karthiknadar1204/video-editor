export type Timeline = {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  videoTrack: {
    id: string;
    src: string;
    start: number;
    sourceStart: number;
    duration: number;
  }[];
  title: { text: string; start: number; duration: number } | null;
};

export const canvasFormats = ["landscape", "portrait", "square"] as const;
export type CanvasFormat = typeof canvasFormats[number];
const dimensions = { landscape: [1280, 720], portrait: [720, 1280], square: [1080, 1080] } as const;

export function createEmptyTimeline(id: string, name: string, format: CanvasFormat): Timeline {
  const [width, height] = dimensions[format];
  return { id, name, width, height, fps: 30, durationInFrames: 0, videoTrack: [], title: null };
}

export const earthrise = {
  id: "Earthrise",
  name: "Earthrise",
  width: 1280,
  height: 720,
  fps: 30,
  durationInFrames: 300,
  videoTrack: [
    { id: "apollo-8", src: "media/earthrise.mp4", start: 0, sourceStart: 0, duration: 300 },
  ],
  title: { text: "Earthrise", start: 150, duration: 150 },
} satisfies Timeline;
