import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { readTimeline, rushes, sample } from "@editor/timeline";
import { and, asc, count, desc, eq, gt, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { projectExportDir } from "../../worker/paths";
import { takeAllowance } from "./allowance";
import { db } from "./db/client";
import { exportAttempt, exportSource, exportVersion, type ExportManifest } from "./db/export-schema";
import { project, projectAsset } from "./db/schema";
import { pinRelease, pinnedBundle } from "./export-release";
import { forgetOutput, publishOutput } from "./export-storage";
import type { EditTransaction } from "./history";
import { storageMode } from "./media-storage";
import { MissingSource, prepareProject, renderSequence } from "./project-render";

export class ExportError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 422 | 429 | 503, message: string) { super(message); }
}
type Owner = { ownerId: string; projectId: string };
type Target = Owner & { exportId: string };
type Attempt = typeof exportAttempt.$inferSelect;
const leaseMs = 45_000;
const retentionMs = 30 * 86_400_000;
const activeStates = ["queued", "rendering", "uploading"] satisfies Attempt["status"][];
const renderingStates = ["rendering", "uploading"] satisfies Attempt["status"][];
const identity = (id: string, n: number) => and(eq(exportAttempt.exportId, id), eq(exportAttempt.number, n));
const workDir = (projectId: string, claim: string) => join(projectExportDir(projectId), "work", claim);
const currentAttempt = and(eq(exportAttempt.exportId, exportVersion.id), eq(exportAttempt.number, exportVersion.attempt));
const owned = (owner: Owner) => and(eq(exportVersion.projectId, owner.projectId), eq(project.ownerId, owner.ownerId), gt(exportVersion.expiresAt, new Date()));
const viewFields = { id: exportVersion.id, projectId: exportVersion.projectId, revision: exportVersion.revision, attempt: exportVersion.attempt,
  title: exportVersion.title, createdAt: exportVersion.createdAt, expiresAt: exportVersion.expiresAt, watchToken: exportVersion.watchToken,
  status: exportAttempt.status, progress: exportAttempt.progress, error: exportAttempt.error };

function queryViews() {
  return db.select(viewFields).from(exportVersion).innerJoin(project, eq(project.id, exportVersion.projectId)).innerJoin(exportAttempt, currentAttempt);
}
function view(row: Awaited<ReturnType<typeof queryViews>>[number]) {
  const { projectId, watchToken, ...result } = row;
  return { ...result, downloadUrl: row.status === "completed" ? "/api/projects/" + projectId + "/exports/" + row.id + "/file" : null,
    watchPath: watchToken && row.status === "completed" ? "/watch/" + watchToken : null };
}
const notFound = () => new ExportError(404, "Export not found.");
async function requireOwner(owner: Owner) {
  if (!z.uuid().safeParse(owner.projectId).success) throw notFound();
  const [p] = await db.select({ id: project.id }).from(project).where(and(eq(project.id, owner.projectId), eq(project.ownerId, owner.ownerId)));
  if (!p) throw new ExportError(404, "Project not found.");
}
export async function getExport(target: Target) {
  if (!z.uuid().safeParse(target.exportId).success || !z.uuid().safeParse(target.projectId).success) throw notFound();
  const [row] = await queryViews().where(and(owned(target), eq(exportVersion.id, target.exportId)));
  if (!row) throw notFound();
  return view(row);
}
export async function listExports(owner: Owner, offset: number) {
  await requireOwner(owner);
  const rows = await queryViews().where(owned(owner)).orderBy(desc(exportVersion.createdAt), desc(exportVersion.id)).offset(offset).limit(31);
  return { items: rows.slice(0, 30).map(view), nextOffset: rows.length > 30 ? offset + 30 : null };
}
async function admit(tx: EditTransaction, ownerId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('cutroom.export.admission'))`);
  const [pending] = await tx.select({ n: count() }).from(exportAttempt).where(inArray(exportAttempt.status, activeStates));
  if (pending.n >= 32) throw new ExportError(429, "The export queue is full. Try again shortly.");
  await takeAllowance(ownerId, "render", tx);
}

export async function startExport(input: Owner & { revision: number }, before?: (tx: EditTransaction) => Promise<void>) {
  await requireOwner(input);
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw new ExportError(422, "Choose a saved revision.");
  const release = await pinRelease();
  const id = await db.transaction(async tx => {
    await before?.(tx);
    const [p] = await tx.select().from(project).where(and(eq(project.id, input.projectId), eq(project.ownerId, input.ownerId))).for("update");
    if (!p) throw notFound();
    const [existing] = await tx.select({ id: exportVersion.id, expiresAt: exportVersion.expiresAt }).from(exportVersion).where(and(eq(exportVersion.projectId, p.id),
      eq(exportVersion.revision, input.revision), eq(exportVersion.release, release.id)));
    if (existing && existing.expiresAt <= new Date()) throw new ExportError(409, "This export is expiring. Try again after cleanup.");
    if (existing) return existing.id;
    if (p.revision !== input.revision) throw new ExportError(409, "The project changed. Load its latest revision before exporting.");
    const timeline = readTimeline(p.formatVersion, p.timeline);
    if (!timeline.durationInFrames) throw new ExportError(422, "Add a clip before exporting.");
    const used = new Set(timeline.clips.flatMap(c => c.kind === "media" ? [c.assetId] : []));
    const assets = timeline.assets.filter(a => used.has(a.id));
    const privateAssets = assets.filter(a => ![sample.src, rushes.src].includes(a.src));
    for (const a of privateAssets) if (!z.uuid().safeParse(a.id).success) throw new ExportError(422, "Missing source media: " + a.name);
    const retained = privateAssets.length ? await tx.select({ id: projectAsset.id }).from(projectAsset).where(and(eq(projectAsset.projectId, p.id),
      eq(projectAsset.state, "ready"), inArray(projectAsset.id, privateAssets.map(a => a.id)))).for("share") : [];
    const missing = privateAssets.find(a => !retained.some(row => row.id === a.id));
    if (missing) throw new ExportError(422, "Missing source media: " + missing.name);
    const manifest: ExportManifest = { composition: release.id, fonts: release.fonts, sources: assets.map(a => ({ id: a.id, version: release.media[a.src] ?? a.id })),
      settings: { codec: "h264", audio: "aac", pixels: "yuv420p", width: timeline.width, height: timeline.height, fps: timeline.fps } };
    await admit(tx, input.ownerId);
    const id = crypto.randomUUID();
    await tx.insert(exportVersion).values({ id, projectId: p.id, revision: p.revision, title: p.title, release: release.id, manifest, timeline: { ...timeline, assets },
      storage: storageMode(), expiresAt: new Date(Date.now() + retentionMs) });
    if (retained.length) await tx.insert(exportSource).values(retained.map(a => ({ exportId: id, assetId: a.id })));
    await tx.insert(exportAttempt).values({ exportId: id, number: 1 });
    return id;
  });
  wakeExportWorker();
  return getExport({ ...input, exportId: id });
}

async function lockVersion(tx: EditTransaction, target: Target) {
  if (![target.projectId, target.exportId].every(id => z.uuid().safeParse(id).success)) throw notFound();
  const [row] = await tx.select({ id: exportVersion.id, attempt: exportVersion.attempt, watchToken: exportVersion.watchToken }).from(exportVersion)
    .innerJoin(project, eq(project.id, exportVersion.projectId)).where(and(owned(target), eq(exportVersion.id, target.exportId))).for("update", { of: exportVersion });
  if (!row) throw notFound();
  return row;
}
export async function changeAttempt(target: Target, action: "retry" | "cancel", expected: number) {
  await db.transaction(async tx => {
    const v = await lockVersion(tx, target);
    if (v.attempt !== expected) return;
    const where = identity(v.id, v.attempt);
    if (action === "cancel") {
      await tx.update(exportAttempt).set({ status: "cancelled", endedAt: new Date(), leaseUntil: null }).where(and(where, inArray(exportAttempt.status, activeStates)));
      return;
    }
    const [a] = await tx.select().from(exportAttempt).where(where).for("update");
    if (!a || (a.status !== "failed" && a.status !== "cancelled")) throw new ExportError(409, "Only a failed or cancelled export can be retried.");
    await admit(tx, target.ownerId);
    await tx.insert(exportAttempt).values({ exportId: v.id, number: v.attempt + 1 });
    await tx.update(exportVersion).set({ attempt: v.attempt + 1, expiresAt: new Date(Date.now() + retentionMs) }).where(eq(exportVersion.id, v.id));
  });
  if (action === "cancel") controllers.get(target.exportId + "/" + expected)?.abort();
  wakeExportWorker();
  return getExport(target);
}

export async function changeShare(target: Target, shared: boolean) {
  await db.transaction(async tx => {
    const v = await lockVersion(tx, target);
    const [a] = await tx.select({ status: exportAttempt.status }).from(exportAttempt).where(identity(v.id, v.attempt));
    if (a?.status !== "completed") throw new ExportError(409, "Complete this export before sharing it.");
    await tx.update(exportVersion).set({ watchToken: shared ? v.watchToken ?? crypto.randomUUID() : null }).where(eq(exportVersion.id, v.id));
  });
  return getExport(target);
}
export async function completedVersion(target: Target | { token: string } | (Owner & { revision: number })) {
  let clause;
  if ("token" in target) {
    if (!z.uuid().safeParse(target.token).success) throw notFound();
    clause = eq(exportVersion.watchToken, target.token);
  } else {
    if (!z.uuid().safeParse(target.projectId).success || ("exportId" in target && !z.uuid().safeParse(target.exportId).success)) throw notFound();
    clause = and(owned(target), "exportId" in target ? eq(exportVersion.id, target.exportId) : eq(exportVersion.revision, target.revision));
  }
  const [row] = await db.select({ id: exportVersion.id, projectId: exportVersion.projectId, title: exportVersion.title, revision: exportVersion.revision,
    storage: exportVersion.storage, attempt: exportVersion.attempt }).from(exportVersion).innerJoin(project, eq(project.id, exportVersion.projectId))
    .innerJoin(exportAttempt, currentAttempt).where(and(clause, gt(exportVersion.expiresAt, new Date()), eq(exportAttempt.status, "completed")))
    .orderBy(desc(exportVersion.createdAt)).limit(1);
  if (!row) throw notFound();
  return row;
}

async function claimNext() {
  return db.transaction(async tx => {
    const now = new Date();
    const [v] = await tx.select({ version: exportVersion, previous: exportAttempt }).from(exportVersion).innerJoin(exportAttempt, currentAttempt)
      .where(and(gt(exportVersion.expiresAt, now), or(eq(exportAttempt.status, "queued"), and(inArray(exportAttempt.status, renderingStates),
        lt(exportAttempt.leaseUntil, now))))).orderBy(asc(exportAttempt.createdAt)).limit(1).for("update", { skipLocked: true });
    if (!v) return;
    let number = v.previous.number;
    if (v.previous.status !== "queued") {
      await tx.update(exportAttempt).set({ status: "failed", endedAt: now, leaseUntil: null, error: "The render worker was interrupted." })
        .where(identity(v.version.id, number));
      if (number >= 3) return { kind: "recovered" as const };
      number++;
      await tx.insert(exportAttempt).values({ exportId: v.version.id, number });
      await tx.update(exportVersion).set({ attempt: number }).where(eq(exportVersion.id, v.version.id));
    }
    const claim = crypto.randomUUID();
    await tx.update(exportAttempt).set({ status: "rendering", claim, leaseUntil: new Date(Date.now() + leaseMs) }).where(identity(v.version.id, number));
    return { kind: "job" as const, version: v.version, number, claim };
  });
}

const controllers = new Map<string, AbortController>();
async function runNext() {
  const job = await claimNext();
  if (!job) return false;
  if (job.kind === "recovered") return true;
  const { version: v, number, claim } = job;
  const key = v.id + "/" + number, controller = new AbortController();
  controllers.set(key, controller);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20 * 60_000)]);
  const mine = and(identity(v.id, number), eq(exportAttempt.claim, claim), inArray(exportAttempt.status, renderingStates));
  const beat = setInterval(() => {
    void db.update(exportAttempt).set({ leaseUntil: new Date(Date.now() + leaseMs) }).where(mine).returning({ n: exportAttempt.number })
      .then(rows => { if (!rows.length) controller.abort(); }).catch(() => controller.abort());
  }, 8_000);
  const directory = workDir(v.projectId, claim);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const bundle = await pinnedBundle(v.release);
    await prepareProject(directory, v.projectId, v.timeline, signal);
    let pending = "", progress = 0;
    await renderSequence(async chunk => {
      const lines = (pending + new TextDecoder().decode(chunk)).split("\n");
      pending = lines.pop() ?? "";
      const seen = Math.max(progress, ...lines.filter(l => /^\d{1,3}$/.test(l)).map(Number));
      if (seen >= progress + 5) {
        progress = Math.min(99, seen);
        await db.update(exportAttempt).set({ progress }).where(mine);
      }
    }, directory, { bundle, signal });
    const uploading = await db.update(exportAttempt).set({ status: "uploading", progress: 99 }).where(mine).returning({ n: exportAttempt.number });
    if (!uploading.length) return true;
    const remoteId = await publishOutput(v, number, join(directory, "output.mp4"), signal);
    await db.update(exportAttempt).set({ status: "completed", remoteId, progress: 100, endedAt: new Date(), leaseUntil: null }).where(mine);
  } catch (error) {
    const message = error instanceof MissingSource ? error.message : signal.aborted ? "The export was interrupted. Retry the saved version." :
      "The worker could not render or publish this version. Retry the export.";
    await db.update(exportAttempt).set({ status: "failed", error: message, endedAt: new Date(), leaseUntil: null }).where(mine);
  } finally {
    clearInterval(beat);
    controllers.delete(key);
    await rm(directory, { recursive: true, force: true });
  }
  return true;
}

async function collectExpired() {
  const abandoned = await db.select({ v: exportVersion, n: exportAttempt.number, claim: exportAttempt.claim }).from(exportAttempt).innerJoin(exportVersion, eq(exportVersion.id, exportAttempt.exportId))
    .where(and(inArray(exportAttempt.status, ["failed", "cancelled"]), isNotNull(exportAttempt.claim), lt(exportAttempt.endedAt, new Date(Date.now() - 5 * 60_000)))).limit(12);
  for (const { v, n, claim } of abandoned) {
    if (claim) await rm(workDir(v.projectId, claim), { recursive: true, force: true });
    await forgetOutput(v, n);
    await db.update(exportAttempt).set({ claim: null }).where(identity(v.id, n));
  }
  const expired = await db.select().from(exportVersion).where(lt(exportVersion.expiresAt, new Date())).limit(8);
  for (const v of expired) {
    const attempts = await db.select({ n: exportAttempt.number, claim: exportAttempt.claim }).from(exportAttempt).where(eq(exportAttempt.exportId, v.id));
    for (const a of attempts) {
      if (a.claim) await rm(workDir(v.projectId, a.claim), { recursive: true, force: true });
      await forgetOutput(v, a.n);
    }
    await db.delete(exportVersion).where(and(eq(exportVersion.id, v.id), lt(exportVersion.expiresAt, new Date())));
  }
}
let busy = false, pending = false, nextCleanup = 0;
let timer: ReturnType<typeof setInterval> | undefined;
export function wakeExportWorker() {
  if (!timer) { timer = setInterval(wakeExportWorker, 10_000); timer.unref(); }
  pending = true;
  if (busy) return;
  busy = true;
  void (async () => {
    try {
      do { pending = false; if (await runNext()) pending = true; } while (pending);
      if (Date.now() >= nextCleanup) { nextCleanup = Date.now() + 60_000; await collectExpired(); }
    } catch { console.error("Export worker will retry."); }
    finally { busy = false; if (pending) queueMicrotask(wakeExportWorker); }
  })();
}
