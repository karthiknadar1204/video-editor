import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rushes, sample, readTimeline } from "@editor/timeline";
import { and, asc, eq, or, sql } from "drizzle-orm";
import { analysisVersion } from "../../worker/whisper";
import { enqueueMedia } from "./queue";
import { db } from "./db/client";
import { project, projectAsset, sourceAnalysis as jobs } from "./db/schema";
import { originalName } from "./media";
import { stageOriginal } from "./media-storage";

export { analysisVersion };
export const jobKey = (projectId: string, assetId: string) => and(eq(jobs.projectId, projectId), eq(jobs.assetId, assetId), eq(jobs.version, analysisVersion));
const available = () => or(eq(jobs.status, "queued"), and(eq(jobs.status, "processing"), sql`${jobs.leaseUntil} < now()`));
const lease = sql`now() + interval '2 minutes'`;

export async function recoverAnalysisJobs() {
  const pending = await db.select({ projectId: jobs.projectId, assetId: jobs.assetId }).from(jobs)
    .where(and(eq(jobs.version, analysisVersion), available())).orderBy(asc(jobs.createdAt)).limit(100);
  await Promise.all(pending.map(row => enqueueMedia({ kind: "analysis", ...row })));
}

export async function processAnalysisJob(projectId: string, assetId: string) {
  const [job] = await db.update(jobs).set({ status: "processing", leaseId: crypto.randomUUID(), leaseUntil: lease })
    .where(and(jobKey(projectId, assetId), available())).returning();
  if (!job) return;
  const held = and(jobKey(job.projectId, job.assetId), eq(jobs.leaseId, job.leaseId!));
  const heartbeat = setInterval(() => { void db.update(jobs).set({ leaseUntil: lease }).where(held).catch(() => {}); }, 30_000);
  let folder: string | undefined;
  try {
    const [source] = await db.select({ version: project.formatVersion, timeline: project.timeline }).from(project).where(eq(project.id, job.projectId));
    if (!source) return;
    const timeline = readTimeline(source.version, source.timeline);
    const asset = timeline.assets.find(item => item.id === job.assetId);
    if (!asset) throw new Error("Source unavailable");
    const bundled = [sample, rushes].find(item => item.id === asset.id && item.src === asset.src);
    let path: string;
    if (bundled) {
      path = fileURLToPath(new URL("../../web/public/" + bundled.src, import.meta.url));
    } else {
      const [row] = await db.select().from(projectAsset).where(and(eq(projectAsset.projectId, job.projectId), eq(projectAsset.id, asset.id), eq(projectAsset.state, "ready")));
      if (!row) throw new Error("Source unavailable");
      folder = await mkdtemp(join(tmpdir(), "cutroom-analysis-"));
      path = join(folder, originalName(row.mime));
      await stageOriginal(row, path);
    }
    const { makeSourceSheet, transcribeSource } = await import("../../worker/src/analysis");
    const durationMs = Math.round(asset.duration * 1000 / timeline.fps);
    // Keep successful parts across retries, including an empty transcript or audio-only sheet.
    const results = await Promise.allSettled([
      (async () => {
        if (job.timestampsMs !== null) return;
        const sheet = asset.metadata?.mediaType === "audio" ? null : await makeSourceSheet({ path, durationMs, fps: timeline.fps });
        await db.update(jobs).set({ sheet: sheet?.data ?? null, timestampsMs: sheet?.timestampsMs ?? [] }).where(held);
      })(),
      (async () => {
        if (job.originalWords !== null) return;
        const result = await transcribeSource({ path, durationMs, hasAudio: asset.metadata?.hasAudio ?? true });
        await db.update(jobs).set({ originalWords: result.words }).where(held);
      })(),
    ]);
    const status = results.every(result => result.status === "fulfilled") ? "ready" : "failed";
    await db.update(jobs).set({ status, leaseId: null, leaseUntil: null }).where(held);
  } catch {
    await db.update(jobs).set({ status: "failed", leaseId: null, leaseUntil: null }).where(held);
  } finally {
    clearInterval(heartbeat);
    if (folder) await rm(folder, { recursive: true, force: true });
  }
}
