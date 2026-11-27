import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { earthrise } from "@editor/timeline";
import type { QueueEventsListener } from "bullmq";
import { Hono } from "hono";
import { streamText } from "hono/streaming";
import { exportFile, renderDir } from "../../worker/paths";
import { currentExportRelease, pinnedBundle } from "./export-release";
import { publishOutput, streamOutput } from "./export-storage";
import { serveLocalFile, storageMode } from "./media-storage";
import { prepareProject, renderProgress, renderSequence } from "./project-render";
import { addMedia, getQueueEvents, mediaJobId, type MediaJob } from "./queue";

const timeout = 20 * 60_000;
const sampleVersion = (release: string): Parameters<typeof publishOutput>[0] =>
  ({ id: release, projectId: "public-sample", title: "earthrise", storage: storageMode() });

export async function processSampleExport(release: string, workerSignal?: AbortSignal, progress?: (percent: number) => Promise<void>) {
  const signal = workerSignal ? AbortSignal.any([workerSignal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
  signal.throwIfAborted();
  const version = sampleVersion(release);
  await mkdir(renderDir, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(renderDir, "sample-"));
  try {
    const bundle = await pinnedBundle(release);
    await prepareProject(directory, version.projectId, earthrise, signal);
    await renderSequence(renderProgress(percent => progress?.(percent)), directory, { bundle, signal });
    await publishOutput(version, 1, join(directory, "output.mp4"), signal, { replace: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export const sampleExports = new Hono();
sampleExports.post("/", async c => {
  if (c.req.header("Sec-Fetch-Site") === "cross-site") return c.text("Open the editor to export.", 403);
  const release = await currentExportRelease();
  const data = { kind: "sample", release: release.id } satisfies MediaJob;
  const jobId = "sample-" + crypto.randomUUID();
  const job = await addMedia(data, { jobId, deduplication: { id: mediaJobId(data) },
    attempts: 1, removeOnComplete: { age: 120, count: 8 }, removeOnFail: { age: 120, count: 8 } }).catch(() => null);
  if (!job) return c.text("Export is temporarily unavailable. Try again shortly.", 503);
  if (job.id !== jobId) return c.text("An export is already running. Try again in a moment.", 409);
  const events = getQueueEvents();
  c.header("Cache-Control", "no-store, no-transform");
  c.header("X-Accel-Buffering", "no");
  return streamText(c, async stream => {
    let writes = stream.writeln("Rendering");
    const onProgress: QueueEventsListener["progress"] = event => {
      if (event.jobId === jobId && typeof event.data === "number") writes = writes.then(() => stream.writeln(String(event.data)));
    };
    events.on("progress", onProgress);
    try {
      await job.waitUntilFinished(events, timeout);
      await writes;
      await stream.writeln("Ready");
    } catch {
      await writes;
      await stream.writeln("Failed");
    } finally {
      events.off("progress", onProgress);
    }
  });
});

sampleExports.get("/", async c => {
  const release = await currentExportRelease();
  const version = sampleVersion(release.id);
  const download = 'attachment; filename="earthrise.mp4"';
  try {
    const response = await streamOutput(version, 1, c.req.raw, true);
    response.headers.set("Content-Disposition", download);
    return response;
  } catch {
    if (version.storage === "local" && await Bun.file(exportFile).exists()) {
      return serveLocalFile(exportFile, new Headers({ "Content-Type": "video/mp4", "Content-Disposition": download, "Cache-Control": "no-store" }),
        c.req.header("Range"));
    }
    return c.text("Render the sequence first.", 404);
  }
});
