import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTimeline, type Timeline } from "@editor/timeline";
import { and, asc, count, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { enqueueMedia } from "./queue";
import { takeAllowance } from "./allowance";
import { db } from "./db/client";
import { candidateFrame, frameJob, project } from "./db/schema";
import type { EditTransaction } from "./history";
import { prepareProject, renderSequence } from "./project-render";

const maxPending = 16;
const renderTimeoutMs = 120_000;
const staleFrameMs = renderTimeoutMs + 15_000;
const receipt = {
  jobId: frameJob.id, revision: frameJob.revision, frame: frameJob.frame, fps: frameJob.fps,
  status: frameJob.status, data: frameJob.data, error: frameJob.error, updatedAt: frameJob.updatedAt,
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
  if (saved.status === "queued" || saved.updatedAt.getTime() + staleFrameMs <= Date.now()) await enqueueMedia({ kind: "frame", jobId: saved.jobId });
  return { ...meta, status: saved.status };
}

const runnable = () => or(eq(frameJob.status, "queued"), and(eq(frameJob.status, "running"), sql`${frameJob.updatedAt} < now() - ${staleFrameMs} * interval '1 millisecond'`));

export async function recoverFrameJobs() {
  const [frames, candidates] = await Promise.all([
    db.select({ jobId: frameJob.id }).from(frameJob).where(runnable()).orderBy(asc(frameJob.createdAt)).limit(maxPending),
    db.select({ projectId: candidateFrame.projectId, reviewId: candidateFrame.reviewId, revision: candidateFrame.revision, frame: candidateFrame.frame })
      .from(candidateFrame).where(and(isNull(candidateFrame.data), eq(candidateFrame.failed, false))).orderBy(asc(candidateFrame.createdAt)).limit(maxPending),
  ]);
  await Promise.all([...frames.map(row => enqueueMedia({ kind: "frame", ...row })), ...candidates.map(row => enqueueMedia({ kind: "candidate", ...row }))]);
}

export async function renderFramePixels(projectId: string, timeline: Timeline, frame: number) {
  const dir = await mkdtemp(join(tmpdir(), "cutroom-still-"));
  try {
    const signal = AbortSignal.timeout(renderTimeoutMs);
    await prepareProject(dir, projectId, timeline, signal);
    await renderSequence(async () => {}, dir, { frame, signal });
    return (await readFile(join(dir, "frame.jpg"))).toString("base64");
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function processFrameJob(jobId: string) {
  const claimedAt = new Date();
  const [job] = await db.update(frameJob).set({ status: "running", updatedAt: claimedAt })
    .where(and(eq(frameJob.id, jobId), runnable())).returning({ timeline: frameJob.timeline, frame: frameJob.frame, projectId: frameJob.projectId });
  if (!job) return;
  const mine = and(eq(frameJob.id, jobId), eq(frameJob.status, "running"), eq(frameJob.updatedAt, claimedAt));
  let jpeg: string;
  try {
    if (!job.timeline) throw new Error("Missing frame snapshot.");
    jpeg = await renderFramePixels(job.projectId, job.timeline, job.frame);
  } catch {
    await db.update(frameJob).set({ status: "failed", timeline: null, error: "Could not render the saved frame.", updatedAt: new Date() }).where(mine);
    return;
  }
  await db.update(frameJob).set({ status: "ready", data: jpeg, timeline: null, updatedAt: new Date() }).where(mine);
}
