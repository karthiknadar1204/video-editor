import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { earthrise } from "@editor/timeline";
import { bundle } from "@remotion/bundler";
import { ensureBrowser, renderMedia, selectComposition } from "@remotion/renderer";
import { exportFile, renderDir } from "../paths";

async function render() {
  const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE;
  await ensureBrowser({ browserExecutable, logLevel: "error" });
  await mkdir(renderDir, { recursive: true });
  const work = await mkdtemp(join(renderDir, "render-"));
  try {
    const serveUrl = await bundle({
      entryPoint: fileURLToPath(new URL("../../../packages/composition/src/root.tsx", import.meta.url)),
      publicDir: fileURLToPath(new URL("../../web/public", import.meta.url)),
      outDir: join(work, "bundle"),
    });
    const composition = await selectComposition({ serveUrl, id: earthrise.id, browserExecutable });
    let lastPercent = -1;
    await renderMedia({
      serveUrl, composition, browserExecutable,
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
    await rename(join(work, "film.mp4"), exportFile);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

render().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
