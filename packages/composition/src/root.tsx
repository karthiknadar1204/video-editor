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
    />
  );
}

registerRoot(Root);
