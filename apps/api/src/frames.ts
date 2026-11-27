import { mkdir, mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { readTimeline } from "@editor/timeline";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { projectExportDir } from "../../worker/paths";
import { takeAllowance } from "./allowance";
import { db } from "./db/client";
import { frameJob, project } from "./db/schema";
import type { EditTransaction } from "./history";
import { prepareProject, renderSequence } from "./project-export";

const maxPending = 16;
const renderTimeoutMs = 120_000;
const receipt = {
  jobId: frameJob.id, revision: frameJob.revision, frame: frameJob.frame, fps: frameJob.fps,
  status: frameJob.status, data: frameJob.data, error: frameJob.error,
};

export class FrameError extends Error {
  constructor(readonly status: 404 | 409 | 422 | 429, message: string) { super(message); }
}

export async function requestFrame(input: { ownerId: string; projectId: string; revision: number; frame: number }) {
  if (!z.uuid().safeParse(input.projectId).success) throw new FrameError(404, "Project not found.");
  if (![input.revision, input.frame].every(v => Number.isSafeInteger(v) && v >= 0 && v <= 2_147_483_647)) {
    throw new FrameError(422, "Choose a whole, nonnegative frame and revision.");
  }
  const lookup = (conn: EditTransaction | typeof db) => conn.select(receipt).from(frameJob).innerJoin(project, eq(project.id, frameJob.projectId))
    .where(and(eq(project.ownerId, input.ownerId), eq(frameJob.projectId, input.projectId), eq(frameJob.revision, input.revision), eq(frameJob.frame, input.frame)));
  const [cached] = await lookup(db);
  const saved = cached ?? await db.transaction(async tx => {
    // Serialize admission separately from rendering so queue limits and charges apply exactly once.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('cutroom.frame.admission'))`);
    const [existing] = await lookup(tx);
    if (existing) return existing;
    const [p] = await tx.select({ revision: project.revision, timeline: project.timeline, version: project.formatVersion }).from(project)
      .where(and(eq(project.id, input.projectId), eq(project.ownerId, input.ownerId))).for("share");
    if (!p) throw new FrameError(404, "Project not found.");
    if (p.revision !== input.revision) throw new FrameError(409, "The project changed. Read the current revision before rendering a new frame.");
    const timeline = readTimeline(p.version, p.timeline);
    if (input.frame >= timeline.durationInFrames) throw new FrameError(422, "Frame outside the saved timeline.");
    const [queue] = await tx.select({ total: count() }).from(frameJob).where(inArray(frameJob.status, ["queued", "running"]));
    if (queue.total >= maxPending) throw new FrameError(429, "The frame queue is full. Try again shortly.");
    await takeAllowance(input.ownerId, "render", tx);
    // Only these sequences can contribute pixels at this frame. Preserve their source and timeline offsets.
    const clips = timeline.clips.filter(c => c.track !== "speech" && c.track !== "music" && c.start <= input.frame && input.frame < c.start + c.duration);
    const [added] = await tx.insert(frameJob).values({ id: crypto.randomUUID(), projectId: input.projectId, revision: input.revision,
      frame: input.frame, fps: timeline.fps, timeline: { ...timeline, clips }, status: "queued" }).returning(receipt);
    return added;
  });
  const meta = { jobId: saved.jobId, frame: saved.frame, revision: saved.revision, timestampMs: Math.round(saved.frame * 1000 / saved.fps) };
  if (saved.status === "ready" && saved.data) return { ...meta, status: "ready" as const, mimeType: "image/jpeg" as const, data: saved.data };
  if (saved.status === "failed" || saved.status === "ready") return { ...meta, status: "failed" as const, error: saved.error ?? "Could not render the saved frame." };
  wakeFrameWorker();
  return { ...meta, status: saved.status };
}

async function renderNext() {
  return db.transaction(async tx => {
    // A transaction lock is released on process death, including behind Neon's transaction pooler.
    const [lock] = await tx.execute<{ held: boolean }>(sql`select pg_try_advisory_xact_lock(hashtext('cutroom.frame.renderer')) as held`);
    if (!lock.held) return "busy";
    const [job] = await tx.select({ id: frameJob.id, projectId: frameJob.projectId, frame: frameJob.frame, timeline: frameJob.timeline }).from(frameJob)
      .where(inArray(frameJob.status, ["queued", "running"])).orderBy(asc(frameJob.createdAt), asc(frameJob.id)).limit(1);
    if (!job) return "idle";
    const row = eq(frameJob.id, job.id);
    // Publish progress on a separate connection while the worker holds the renderer lock.
    await db.update(frameJob).set({ status: "running", updatedAt: new Date() }).where(row);
    const work = join(projectExportDir(job.projectId), "frames", job.id);
    let directory: string | undefined;
    try {
      if (!job.timeline) throw new Error("Missing frame snapshot.");
      await rm(work, { recursive: true, force: true });
      await mkdir(work, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(work, "attempt-"));
      const signal = AbortSignal.timeout(renderTimeoutMs);
      await prepareProject(directory, job.projectId, job.timeline, signal);
      await renderSequence(async () => {}, directory, { frame: job.frame, signal });
      const jpeg = await readFile(join(directory, "frame.jpg"));
      await tx.update(frameJob).set({ status: "ready", data: jpeg.toString("base64"), timeline: null, updatedAt: new Date() }).where(row);
    } catch {
      await tx.update(frameJob).set({ status: "failed", timeline: null, error: "Could not render the saved frame.", updatedAt: new Date() }).where(row);
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
      // Another attempt may own this directory after a lost database connection.
      await rmdir(work).catch(() => {});
    }
    return "rendered";
  });
}

let draining = false;
let pending = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

export function wakeFrameWorker() {
  pending = true;
  if (draining || retryTimer) return;
  draining = true;
  void (async () => {
    try {
      do {
        pending = false;
        const result = await renderNext();
        if (result === "rendered") pending = true;
        if (result === "busy") { scheduleRetry(); break; }
      } while (pending);
    } catch {
      scheduleRetry();
    } finally { draining = false; }
  })();
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = undefined; wakeFrameWorker(); }, 3000);
  retryTimer.unref();
}
