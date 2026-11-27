import { cp, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { earthrise, timelineSchema } from "@editor/timeline";
import { bundle } from "@remotion/bundler";
import { ensureBrowser, renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { exportFile, renderDir } from "../paths";

function buildBundle(outDir: string) {
  return bundle({
    entryPoint: fileURLToPath(new URL("../../../packages/composition/src/root.tsx", import.meta.url)),
    publicDir: fileURLToPath(new URL("../../web/public", import.meta.url)),
    outDir,
  });
}

async function render() {
  if (process.env.CUTROOM_FREEZE_BUNDLE) {
    await buildBundle(process.env.CUTROOM_FREEZE_BUNDLE);
    return;
  }
  const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE;
  const job = process.env.CUTROOM_RENDER_JOB;
  const still = process.env.CUTROOM_RENDER_FRAME;
  const timeline = job ? timelineSchema.parse(JSON.parse(await readFile(join(job, "timeline.json"), "utf8"))) : earthrise;
  const inputProps = { timeline };
  await ensureBrowser({ browserExecutable, logLevel: "error" });
  await mkdir(renderDir, { recursive: true });
  const work = await mkdtemp(join(job ?? renderDir, "render-"));
  try {
    const serveUrl = join(work, "bundle");
    if (process.env.CUTROOM_RENDER_BUNDLE) await cp(process.env.CUTROOM_RENDER_BUNDLE, serveUrl, { recursive: true });
    else await buildBundle(serveUrl);
    if (job) await cp(join(job, "assets"), join(serveUrl, "public", "imports"), { recursive: true });
    const composition = await selectComposition({ serveUrl, id: earthrise.id, inputProps, browserExecutable });
    if (job && still !== undefined) {
      const frame = Number(still);
      if (!Number.isInteger(frame) || frame < 0 || frame >= composition.durationInFrames) throw new Error("Frame outside the saved composition.");
      await renderStill({
        serveUrl, composition, inputProps, browserExecutable, frame, output: join(job, "frame.jpg"),
        imageFormat: "jpeg", jpegQuality: 90, scale: Math.min(1, 960 / Math.max(composition.width, composition.height)),
      });
      return;
    }
    let lastPercent = -1;
    await renderMedia({
      serveUrl, composition, inputProps, browserExecutable,
      codec: "h264", audioCodec: "aac", pixelFormat: "yuv420p",
      concurrency: 2,
      outputLocation: join(work, "film.mp4"),
      onProgress: ({ progress }) => {
        const percent = Math.floor(progress * 100);
        if (percent !== lastPercent) {
          process.stdout.write(percent + "\n");
          lastPercent = percent;
        }
      },
    });
    await rename(join(work, "film.mp4"), job ? join(job, "output.mp4") : exportFile);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

render().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
