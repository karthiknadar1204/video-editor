import { isDeepStrictEqual } from "node:util";
import { editTimeline, prepareRoughCut, readTimeline, restorePassage, roughCutOptionsSchema, roughCutReceiptSchema,
  type RoughCutOptions, type Timeline, type TranscriptWord } from "@editor/timeline";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { analysisVersion } from "./analysis-worker";
import { takeAllowance } from "./allowance";
import { authorizeProjectAccess, selectionWasRemoved, type ProjectAccess } from "./codex-access";
import { recordEdit } from "./codex-runs-store";
import { db } from "./db/client";
import { candidateFrame, codexRun, project, projectEdit as history, roughCutReview as reviews, sourceAnalysis, sourceTranscript } from "./db/schema";
import { HistoryError, saveEditInTransaction, type EditTransaction } from "./history";
import { renderFramePixels } from "./frames";
import { enqueueMedia, requestCandidateFrame } from "./queue";

type Owner = { ownerId: string; projectId: string };
type Access = Owner | ProjectAccess;
type Review = typeof reviews.$inferSelect;
type Conn = typeof db | EditTransaction;
const key = (access: Access, id: string) => and(eq(reviews.projectId, access.projectId), eq(reviews.id, id));
const projectKey = (a: Access) => and(eq(project.id, a.projectId), eq(project.ownerId, a.ownerId));
const op = sql`${history.command}->'operations'->0`;
const opReview = sql<string | null>`${op}->>'reviewId'`;
const opCut = sql<string | null>`${op}->>'cutId'`;

class PendingSources extends HistoryError {
  constructor(readonly ids: string[]) { super(409, "Speech analysis is still processing. Try again when it finishes."); }
}
async function prepareTransaction<T>(access: Access, work: (tx: EditTransaction) => Promise<T>) {
  try { return await db.transaction(work); }
  catch (error) {
    if (error instanceof PendingSources) {
      if (error.ids.length) await db.insert(sourceAnalysis).values(error.ids.map(assetId => ({
        projectId: access.projectId, assetId, version: analysisVersion,
      }))).onConflictDoNothing();
      await Promise.all(error.ids.map(assetId => enqueueMedia({ kind: "analysis", projectId: access.projectId, assetId })));
    }
    throw error;
  }
}

async function lockProject(tx: EditTransaction, access: Access) {
  const auth = "kind" in access ? await authorizeProjectAccess(tx, access) : undefined;
  const [row] = await tx.select({ version: project.formatVersion, timeline: project.timeline, revision: project.revision }).from(project)
    .where(projectKey(access)).for("no key update");
  if (!row) throw new HistoryError(404, "Project not found.");
  return { timeline: readTimeline(row.version, row.timeline), revision: row.revision, auth };
}

async function scopedReview(conn: Conn, access: Access, id: string) {
  const [r] = await conn.select({ review: reviews, runStatus: codexRun.status, expiresAt: codexRun.expiresAt }).from(reviews)
    .innerJoin(project, eq(project.id, reviews.projectId)).leftJoin(codexRun, eq(codexRun.id, reviews.runId))
    .where(and(projectKey(access), key(access, id)));
  if (!r) throw new HistoryError(404, "Review not found.");
  if (r.review.committedRevision === null && r.review.runId &&
    (r.runStatus === "failed" || r.runStatus === "stopped" || (r.runStatus === "running" && r.expiresAt && r.expiresAt <= new Date()))) {
    throw new HistoryError(409, "This unfinished Codex draft has ended.");
  }
  return r.review;
}

async function ledger(conn: Conn, access: Access) {
  const where = eq(history.projectId, access.projectId);
  const [entries, [latest]] = await Promise.all([
    conn.select({ id: opReview, cut: opCut, state: history.state, revision: history.revision, requestId: history.requestId, affected: history.affected })
      .from(history).where(and(where, sql`${opReview} is not null`)).orderBy(history.revision),
    conn.select({ id: opReview }).from(history).where(and(where, eq(history.state, "applied"))).orderBy(desc(history.revision)).limit(1),
  ]);
  return { entries, top: latest?.id };
}
type Ledger = Awaited<ReturnType<typeof ledger>>;
function state(row: Pick<Review, "id" | "committedRevision">, log: Ledger) {
  const entries = log.entries.filter(e => e.id === row.id);
  const main = entries.find(e => e.revision === row.committedRevision);
  const status = row.committedRevision === null ? "draft" as const : main?.state ?? "abandoned" as const;
  return { status, restoredIds: entries.flatMap(e => e.state === "applied" && e.cut ? [e.cut] : []), canUndoReview: log.top === row.id && status === "applied" };
}
function summary(row: Pick<Review, "id"|"baseRevision"|"committedRevision"|"options">, receipt: unknown, log: Ledger) {
  return { id: row.id, baseRevision: row.baseRevision, committedRevision: row.committedRevision, options: row.options,
    receipt: roughCutReceiptSchema.parse(receipt), ...state(row, log) };
}
function detail(row: Review, log: Ledger) {
  const after = row.operations.length ? editTimeline(row.before, row.operations).timeline : row.before;
  return { ...summary(row, row.receipt, log), before: row.before, after };
}

export async function listRoughCuts(access: Owner, offset: number) {
  const [p] = await db.select({ id: project.id }).from(project).where(projectKey(access));
  if (!p) throw new HistoryError(404, "Project not found.");
  const rows = await db.select({ id: reviews.id, baseRevision: reviews.baseRevision, committedRevision: reviews.committedRevision, options: reviews.options,
    receipt: sql`${reviews.receipt} - 'context'` }).from(reviews).leftJoin(codexRun, eq(codexRun.id, reviews.runId))
    .where(and(eq(reviews.projectId, access.projectId), sql`(${reviews.committedRevision} is not null or ${reviews.runId} is null or
      ${codexRun.status} = 'completed' or (${codexRun.status} = 'running' and ${codexRun.expiresAt} > now()))`))
    .orderBy(desc(reviews.createdAt), desc(reviews.id)).offset(offset).limit(31);
  const log = await ledger(db, access);
  return { reviews: rows.slice(0, 30).map(row => summary(row, row.receipt, log)).filter(r => r.status !== "abandoned"),
    nextOffset: rows.length > 30 ? offset + 30 : null };
}
export async function getRoughCut(access: Access, id: string) {
  const row = await scopedReview(db, access, id);
  return detail(row, await ledger(db, access));
}

async function checkScope(tx: EditTransaction, access: Access, options: RoughCutOptions, revision: number) {
  if (!("kind" in access) || access.kind !== "run") return;
  const { clipId, range } = access.context;
  if (clipId && await selectionWasRemoved(access, revision, tx)) {
    throw new HistoryError(409, "The selected clip changed. Select it again.");
  }
  if ("clipId" in options.target) {
    if (clipId ? options.target.clipId !== clipId : range !== null) throw new HistoryError(422, "Use the selected clip or its captured range.");
  } else if (range ? options.target.from < range.from || options.target.to > range.to : clipId !== null) {
    throw new HistoryError(422, "Use the range captured for this turn.");
  }
}

async function calculate(tx: EditTransaction, a: Access, timeline: Timeline, revision: number, options: RoughCutOptions, id: string) {
  await checkScope(tx, a, options, revision);
  const { target } = options;
  const clips = timeline.clips.filter(c => c.kind === "media" && c.track !== "music" && ("clipId" in target
    ? c.id === target.clipId : c.start < target.to && c.start + c.duration > target.from));
  const ids = [...new Set(clips.flatMap(c => c.kind === "media" ? [c.assetId] : []))];
  const words: Record<string, TranscriptWord[]> = {};
  if (ids.length) {
    const existing = await tx.select({ id: sourceAnalysis.assetId, status: sourceAnalysis.status, words: sql<TranscriptWord[] | null>
      `coalesce(${sourceTranscript.reviewed}, ${sourceTranscript.imported}, ${sourceAnalysis.originalWords})` }).from(sourceAnalysis)
      .leftJoin(sourceTranscript, and(eq(sourceAnalysis.projectId, sourceTranscript.projectId), eq(sourceAnalysis.assetId, sourceTranscript.assetId)))
      .where(and(eq(sourceAnalysis.projectId, a.projectId), eq(sourceAnalysis.version, analysisVersion), inArray(sourceAnalysis.assetId, ids)));
    const missing = ids.filter(id => !existing.some(row => row.id === id));
    if (missing.length || existing.some(r => !r.words && r.status !== "failed")) throw new PendingSources([...missing, ...existing.filter(r => !r.words && r.status !== "failed").map(r => r.id)]);
    if (existing.some(r => !r.words && r.status === "failed")) throw new HistoryError(422, "Speech analysis failed. Retry it or import subtitles in the media library.");
    for (const r of existing) words[r.id] = r.words ?? [];
  }
  return prepareRoughCut(timeline, words, options, id);
}

export async function previewRoughCut(access: Access, input: RoughCutOptions, requestId: string) {
  const options = roughCutOptionsSchema.parse(input);
  return prepareTransaction(access, async tx => {
    const p = await lockProject(tx, access);
    const [existing] = await tx.select({ id: reviews.id }).from(reviews).where(key(access, requestId));
    if (existing) {
      const row = await scopedReview(tx, access, requestId);
      if (!isDeepStrictEqual(row.options, options)) throw new HistoryError(409, "Preview ID already used for different settings.");
      return detail(row, await ledger(tx, access));
    }
    const plan = await calculate(tx, access, p.timeline, p.revision, options, requestId);
    const [row] = await tx.insert(reviews).values({ projectId: access.projectId, runId: "kind" in access && access.kind === "run" ? access.id : null,
      id: requestId, baseRevision: p.revision, before: p.timeline, options, receipt: plan.receipt, operations: plan.operations }).returning();
    return detail(row, await ledger(tx, access));
  });
}

export async function commitRoughCut(access: Access, id: string, expectedRevision: number) {
  return prepareTransaction(access, async tx => {
    const p = await lockProject(tx, access);
    let row = await scopedReview(tx, access, id);
    const log = await ledger(tx, access);
    const view = detail(row, log);
    if (row.committedRevision !== null) {
      if (view.status !== "applied") throw new HistoryError(409, "This edit is in history. Use Redo to reapply an undone edit.");
      const receipt = log.entries.find(e => e.revision === row.committedRevision)!;
      return { review: view, receipt: { requestId: receipt.requestId, revision: receipt.revision, affected: receipt.affected }, rebased: false };
    }
    await checkScope(tx, access, row.options, p.revision);
    if ("kind" in access && access.kind === "run" && row.runId !== access.id) throw new HistoryError(409, "Preview this candidate in the current turn.");
    if (row.runId && !("kind" in access && access.kind === "run")) {
      const [agent] = await tx.select({ status: codexRun.status }).from(codexRun).where(eq(codexRun.id, row.runId));
      if (agent?.status !== "completed") throw new HistoryError(409, "Let the Codex turn finish before applying its draft here.");
    }
    if (p.auth?.receipt) throw new HistoryError(409, "This turn has already saved an edit.");
    if (p.revision !== row.baseRevision) {
      const plan = await calculate(tx, access, p.timeline, p.revision, row.options, id);
      [row] = await tx.update(reviews).set({ baseRevision: p.revision, before: p.timeline, operations: plan.operations,
        receipt: plan.receipt, previewImage: null }).where(key(access, id)).returning();
      await tx.delete(candidateFrame).where(and(eq(candidateFrame.projectId, access.projectId), eq(candidateFrame.reviewId, id), sql`${candidateFrame.revision} <> ${p.revision}`));
      return { review: detail(row, log), receipt: null, rebased: true };
    }
    if (row.baseRevision !== expectedRevision) return { review: view, receipt: null, rebased: true };
    if (!row.operations.length) throw new HistoryError(422, "The candidate has no changes to apply.");
    const run = "kind" in access && access.kind === "run" ? access : null;
    const receipt = await saveEditInTransaction(tx, access.projectId, access.ownerId, { kind: "edit", requestId: run?.id ?? row.id,
      expectedRevision, operations: row.operations });
    await tx.update(reviews).set({ committedRevision: receipt.revision }).where(key(access, id));
    if (run) await recordEdit(tx, run.id, receipt, "Rough cut saved");
    return { review: { ...view, committedRevision: receipt.revision, status: "applied" as const, canUndoReview: true }, receipt, rebased: false };
  });
}

export async function restoreRoughPassage(access: Access, id: string, cutId: string, expectedRevision: number, requestId: string) {
  return db.transaction(async tx => {
    const p = await lockProject(tx, access);
    const row = await scopedReview(tx, access, id);
    const log = await ledger(tx, access);
    const run = "kind" in access && access.kind === "run" ? access : null;
    const commandId = run?.id ?? requestId;
    const prior = log.entries.find(e => e.requestId === commandId);
    if (prior) {
      if (prior.id !== id || prior.cut !== cutId) throw new HistoryError(409, "This request already saved a different edit.");
      return { requestId: prior.requestId, revision: prior.revision, affected: prior.affected };
    }
    const current = state(row, log);
    if (current.status !== "applied" || p.revision !== expectedRevision) throw new HistoryError(409, "Refresh the applied review before restoring.", p.revision);
    if (run && run.context.clipId && !row.receipt.cuts.some(c => c.id === cutId && c.clipId === run.context.clipId)) throw new HistoryError(422, "Restore a passage from the selected clip.");
    if (run?.context.range) {
      const cut = row.receipt.cuts.find(c => c.id === cutId);
      if (!cut || cut.at < run.context.range.from || cut.at >= run.context.range.to) throw new HistoryError(422, "Restore a passage inside the selected range.");
    }
    const operations = restorePassage(p.timeline, row.receipt, cutId, current.restoredIds);
    const receipt = await saveEditInTransaction(tx, access.projectId, access.ownerId, { kind: "edit", requestId: commandId, expectedRevision, operations });
    if (run) await recordEdit(tx, run.id, receipt, "Passage restored");
    return receipt;
  });
}
export async function undoReview(access: Owner, id: string, expectedRevision: number, requestId: string) {
  return db.transaction(async tx => {
    await lockProject(tx, access);
    const row = await scopedReview(tx, access, id);
    const [prior] = await tx.select({ target: history.targetRevision, command: history.command }).from(history)
      .where(and(eq(history.projectId, access.projectId), eq(history.requestId, requestId)));
    const log = await ledger(tx, access);
    if (prior ? prior.command.kind !== "undo" || !log.entries.some(e => e.id === id && e.revision === prior.target)
      : !state(row, log).canUndoReview) throw new HistoryError(409, "Undo newer timeline edits before undoing this review.");
    return saveEditInTransaction(tx, access.projectId, access.ownerId, { kind: "undo", requestId, expectedRevision });
  });
}

type Candidate = { projectId: string; reviewId: string; revision: number; frame: number };
const frameKey = (job: Candidate) => and(eq(candidateFrame.projectId, job.projectId), eq(candidateFrame.reviewId, job.reviewId),
  eq(candidateFrame.revision, job.revision), eq(candidateFrame.frame, job.frame));

function candidatePicture(row: Review, frame: number) {
  const after = row.operations.length ? editTimeline(row.before, row.operations).timeline : row.before;
  if (!Number.isInteger(frame) || frame < 0 || frame >= after.durationInFrames) throw new HistoryError(422, "Frame outside the candidate.");
  return { ...after, clips: after.clips.filter(c => c.track !== "music" && c.track !== "speech" && c.start <= frame && c.start + c.duration > frame) };
}

async function readCandidate(tx: EditTransaction, access: Access, id: string) {
  if ("kind" in access) await authorizeProjectAccess(tx, access);
  await tx.select({ id: reviews.id }).from(reviews).where(key(access, id)).for("share");
  return scopedReview(tx, access, id);
}

export async function reviewFrame(access: Access, id: string, frame: number) {
  const job = await db.transaction(async tx => {
    const row = await readCandidate(tx, access, id);
    candidatePicture(row, frame);
    const input = { projectId: access.projectId, reviewId: id, revision: row.baseRevision, frame };
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('cutroom.candidate.admission'))`);
    const [existing] = await tx.select({ data: candidateFrame.data, failed: candidateFrame.failed }).from(candidateFrame).where(frameKey(input));
    if (existing && !existing.failed) return { input, data: existing.data };
    const [pending] = await tx.select({ n: count() }).from(candidateFrame).where(and(isNull(candidateFrame.data), eq(candidateFrame.failed, false)));
    if (pending.n >= 2) throw new HistoryError(409, "Candidate previews are busy. Retry this frame shortly.");
    if (existing) await tx.update(candidateFrame).set({ failed: false }).where(frameKey(input));
    else await tx.insert(candidateFrame).values(input);
    await takeAllowance(access.ownerId, "render", tx);
    return { input, data: null };
  });
  let data = job.data;
  if (!data) {
    await requestCandidateFrame(job.input).catch(() => {});
    data = await db.transaction(async tx => {
      const current = await readCandidate(tx, access, id);
      if (current.baseRevision !== job.input.revision) throw new HistoryError(409, "The candidate changed. Inspect it again.");
      const [cached] = await tx.select({ jpeg: candidateFrame.data, failed: candidateFrame.failed }).from(candidateFrame).where(frameKey(job.input));
      if (!cached?.jpeg) {
        if (cached?.failed) throw new HistoryError(422, "Could not render this candidate frame.");
        throw new HistoryError(409, "Candidate preview is still queued. Retry this frame shortly.");
      }
      return cached.jpeg;
    });
  }
  return { kind: "rough_cut_candidate" as const, reviewId: id, baseRevision: job.input.revision, frame, mimeType: "image/jpeg" as const, data };
}

export async function processCandidateFrame(job: Candidate, finalAttempt = true) {
  const pending = and(frameKey(job), isNull(candidateFrame.data), eq(candidateFrame.failed, false));
  const [entry] = await db.select({ id: candidateFrame.reviewId }).from(candidateFrame).where(pending);
  if (!entry) return;
  const [owner] = await db.select({ ownerId: project.ownerId }).from(project).where(eq(project.id, job.projectId));
  if (!owner) return;
  let jpeg: string;
  try {
    const row = await scopedReview(db, { ownerId: owner.ownerId, projectId: job.projectId }, job.reviewId);
    if (row.baseRevision !== job.revision) throw new HistoryError(409, "The candidate changed.");
    jpeg = await renderFramePixels(job.projectId, candidatePicture(row, job.frame), job.frame);
  } catch {
    if (finalAttempt) await db.update(candidateFrame).set({ failed: true }).where(pending);
    throw new Error("Could not render this candidate frame.");
  }
  await db.update(candidateFrame).set({ data: jpeg }).where(pending);
}
