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
  title: { text: string; start: number; duration: number };
};

export const earthrise: Timeline = {
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
};
