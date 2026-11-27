import { Worker } from "bullmq";
import { processAnalysisJob, recoverAnalysisJobs } from "./analysis-worker";
import { cleanExpiredUploads, processUploadJob, recoverUploads } from "./assets";
import { reconcileExports, processExport } from "./export-jobs";
import { prepareExportRelease } from "./export-release";
import { processFrameJob, recoverFrameJobs } from "./frames";
import { processCandidateFrame } from "./rough-cuts";
import { processSampleExport } from "./sample-export";
import { closeMediaQueue, getMediaQueue, mediaJob, queueName, queueOptions, type MediaJob } from "./queue";

async function recover() {
  await Promise.all([recoverUploads(), recoverAnalysisJobs(), recoverFrameJobs(), reconcileExports(), cleanExpiredUploads()]);
}

const queue = getMediaQueue();
await queue.upsertJobScheduler("maintenance", { every: 60_000 }, { name: "maintenance", data: { kind: "maintenance" } });
await Promise.all([recover(), prepareExportRelease()]);
const worker = new Worker<MediaJob>(queueName, async (job, _token, signal) => {
  const data = mediaJob.parse(job.data);
  switch (data.kind) {
    case "upload": return processUploadJob(data);
    case "analysis": return processAnalysisJob(data.projectId, data.assetId);
    case "frame": return processFrameJob(data.jobId);
    case "candidate": return processCandidateFrame(data, job.attemptsMade + 1 >= (job.opts.attempts ?? 1));
    case "export": return processExport(data.exportId, data.attempt, signal);
    case "sample": return processSampleExport(data.release, signal, percent => job.updateProgress(percent));
    case "maintenance": return recover();
  }
}, { ...queueOptions(true), concurrency: 2 });
worker.on("error", () => console.error("Media worker connection interrupted."));
worker.on("failed", job => console.error("Media job failed", job?.name, job?.id));
await worker.waitUntilReady();
console.log("Cutroom worker ready");

async function shutdown() {
  await worker.close();
  await closeMediaQueue();
  process.exit(0);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
