import { Composition, registerRoot } from "remotion";
import { earthrise } from "@editor/timeline";
import { Film } from "./Film";

function Root() {
  return (
    <Composition
      id={earthrise.id}
      component={Film}
      defaultProps={{ timeline: earthrise }}
      width={earthrise.width}
      height={earthrise.height}
      fps={earthrise.fps}
      durationInFrames={earthrise.durationInFrames}
      calculateMetadata={({ props: { timeline } }) => ({
        width: timeline.width, height: timeline.height, fps: timeline.fps, durationInFrames: timeline.durationInFrames,
      })}
    />
  );
}

registerRoot(Root);
