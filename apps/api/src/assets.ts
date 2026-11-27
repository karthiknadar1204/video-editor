import { readTimeline } from "@editor/timeline";
import { and, asc, eq, gt, isNotNull, lt, ne } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "./db/client";
import { project, projectAsset, sourceAnalysis } from "./db/schema";
import { analysisVersion } from "../../worker/whisper";
import { enqueueMedia, requestUpload } from "./queue";
import { maxBytes, MediaError, originalName } from "./media";
import { processUpload, removeAbandoned, serveAsset, storageMode, storeLocalOriginal, uploadTarget } from "./media-storage";

type AssetRow = typeof projectAsset.$inferSelect;
const reserve = z.strictObject({ name: z.string().trim().min(1).max(255), type: z.string().max(100), size: z.int().positive() });
const attach = z.strictObject({ fileId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional() });
const path = (row: AssetRow) => "/api/projects/" + row.projectId + "/assets/" + row.id;
const byAsset = (row: AssetRow) => and(eq(projectAsset.id, row.id), eq(projectAsset.projectId, row.projectId));
export const assets = new Hono<{ Variables: { ownerId: string; sessionId: string; upload: AssetRow } }>().basePath("/:id/assets");

assets.onError((error, c) => {
  if (error instanceof MediaError) return c.json({ error: error.message }, error.status);
  console.error("Media request failed", error.name);
  return c.json({ error: "Media storage is unavailable. Try again." }, 503);
});

assets.use("*", async (c, next) => {
  const id = c.req.param("id");
  if (!z.uuid().safeParse(id).success) return c.json({ error: "Project not found." }, 404);
  const [owned] = await db.select({ id: project.id }).from(project).where(and(eq(project.id, id), eq(project.ownerId, c.get("ownerId"))));
  if (!owned) return c.json({ error: "Project not found." }, 404);
  await next();
});

assets.post("/", async c => {
  const data = reserve.safeParse(await c.req.json().catch(() => null));
  if (!data.success) throw new MediaError("Supply the file name, media type and size.", 400);
  if (data.data.size > maxBytes) throw new MediaError("Choose a recording under 64 MiB.", 413);
  originalName(data.data.type);
  const [row] = await db.insert(projectAsset).values({ id: crypto.randomUUID(), projectId: c.req.param("id"),
    name: data.data.name, mime: data.data.type, size: data.data.size, state: "pending", storage: storageMode(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000) }).returning();
  return c.json({ id: row.id, upload: uploadTarget(row, path(row)) }, 201);
});

assets.use("/:assetId/*", async (c, next) => {
  const id = c.req.param("assetId");
  if (!z.uuid().safeParse(id).success) throw new MediaError("Media not found.", 404);
  const [row] = await db.select().from(projectAsset).where(and(eq(projectAsset.id, id), eq(projectAsset.projectId, c.req.param("id"))));
  if (!row || row.state === "cancelled" || (row.state !== "ready" && row.expiresAt.getTime() <= Date.now())) throw new MediaError("Upload expired or unavailable.", 404);
  c.set("upload", row);
  await next();
});

assets.put("/:assetId/original", async c => {
  const row = c.get("upload");
  if (row.state !== "pending") throw new MediaError("This upload is already closed.", 409);
  await storeLocalOriginal(row, c.req.raw);
  return c.body(null, 204);
});

assets.post("/:assetId", async c => {
  const data = attach.safeParse(await c.req.json().catch(() => null));
  if (!data.success) throw new MediaError("Invalid upload receipt.", 400);
  const row = c.get("upload");
  if (row.state === "ready" && row.asset) return c.json(row.asset);
  const fileId = data.data.fileId ?? null;
  const ticket = await db.transaction(async tx => {
    const [current] = await tx.select().from(projectAsset).where(byAsset(row)).for("update");
    if (!current || current.state === "cancelled") throw new MediaError("Upload cancelled.", 409);
    if (current.state === "ready" && current.asset) return { asset: current.asset };
    if (current.state === "processing" && current.uploadAttempt) {
      if (current.uploadFileId !== fileId) throw new MediaError("A different upload receipt is already being processed.", 409);
      return { attempt: current.uploadAttempt };
    }
    const attempt = crypto.randomUUID();
    await tx.update(projectAsset).set({ state: "processing", uploadFileId: fileId, uploadAttempt: attempt, uploadError: null }).where(byAsset(row));
    return { attempt };
  });
  if (ticket.asset) return c.json(ticket.asset);
  const job = { projectId: row.projectId, assetId: row.id, attempt: ticket.attempt! };
  // A worker may have saved the asset even if the queue connection carrying the acknowledgement was lost.
  await requestUpload(job).catch(() => {});
  const [saved] = await db.select().from(projectAsset).where(byAsset(row));
  if (saved?.state === "ready" && saved.asset) return c.json(saved.asset);
  if (!saved || saved.state === "cancelled") throw new MediaError("Upload cancelled.", 409);
  if (saved.uploadAttempt === job.attempt && saved.uploadError) throw new MediaError(saved.uploadError.message, saved.uploadError.status);
  throw new MediaError("Media processing is temporarily unavailable. Retry this upload.", 503);
});

type UploadJob = { projectId: string; assetId: string; attempt: string };
export async function recoverUploads() {
  const pending = await db.select({ projectId: projectAsset.projectId, assetId: projectAsset.id, attempt: projectAsset.uploadAttempt }).from(projectAsset)
    .where(and(eq(projectAsset.state, "processing"), isNotNull(projectAsset.uploadAttempt), gt(projectAsset.expiresAt, new Date())))
    .orderBy(asc(projectAsset.expiresAt)).limit(100);
  await Promise.all(pending.flatMap(row => row.attempt ? [enqueueMedia({ kind: "upload", ...row, attempt: row.attempt })] : []));
}

export async function processUploadJob(job: UploadJob) {
  const mine = and(eq(projectAsset.projectId, job.projectId), eq(projectAsset.id, job.assetId), eq(projectAsset.state, "processing"), eq(projectAsset.uploadAttempt, job.attempt));
  const [row] = await db.select().from(projectAsset).where(and(mine, gt(projectAsset.expiresAt, new Date())));
  if (!row) return;
  const [source] = await db.select({ version: project.formatVersion, timeline: project.timeline }).from(project).where(eq(project.id, row.projectId));
  if (!source) return;
  let asset: NonNullable<AssetRow["asset"]>;
  try {
    asset = await processUpload(row, row.uploadFileId ?? undefined, path(row), readTimeline(source.version, source.timeline).fps);
  } catch (cause) {
    const error = cause instanceof MediaError ? cause : new MediaError("Could not process this upload. Retry shortly.", 503);
    await db.update(projectAsset).set({ state: "pending", uploadError: { status: error.status, message: error.message } }).where(mine);
    return;
  }
  await db.transaction(async tx => {
    const [ready] = await tx.update(projectAsset).set({ state: "ready", asset, uploadError: null }).where(mine).returning({ id: projectAsset.id });
    if (!ready) return;
    const [current] = await tx.select().from(project).where(eq(project.id, row.projectId)).for("update");
    const timeline = readTimeline(current.formatVersion, current.timeline);
    timeline.assets.push(asset);
    await tx.insert(sourceAnalysis).values({ projectId: row.projectId, assetId: row.id, version: analysisVersion }).onConflictDoNothing();
    await tx.update(project).set({ timeline, formatVersion: 2, revision: current.revision + 1, updatedAt: new Date() }).where(eq(project.id, current.id));
  });
  await enqueueMedia({ kind: "analysis", projectId: row.projectId, assetId: row.id });
}

assets.delete("/:assetId", async c => {
  const row = c.get("upload");
  const [cancelled] = await db.update(projectAsset).set({ state: "cancelled",
    expiresAt: new Date(Date.now() + 15 * 60_000) }).where(and(byAsset(row), ne(projectAsset.state, "ready"))).returning({ id: projectAsset.id });
  if (!cancelled) throw new MediaError("This file is already part of the project.", 409);
  return c.body(null, 204);
});

assets.get("/:assetId/:kind", async c => {
  const row = c.get("upload");
  if (row.state !== "ready") throw new MediaError("Media is not ready.", 404);
  return serveAsset(row, c.req.param("kind"), c.req.header("Range"));
});

let sweeping = false;
export async function cleanExpiredUploads() {
  if (sweeping) return;
  sweeping = true;
  try {
    const until = new Date();
    const expired = await db.select().from(projectAsset).where(and(ne(projectAsset.state, "ready"), lt(projectAsset.expiresAt, until))).limit(100);
    for (const row of expired) {
      const claimUntil = new Date(Date.now() + 10 * 60_000);
      const [claimed] = await db.update(projectAsset).set({ state: "cancelled", expiresAt: claimUntil })
        .where(and(byAsset(row), ne(projectAsset.state, "ready"), lt(projectAsset.expiresAt, until))).returning();
      if (claimed) {
        await removeAbandoned(claimed);
        await db.delete(projectAsset).where(and(byAsset(row), eq(projectAsset.state, "cancelled"), eq(projectAsset.expiresAt, claimUntil)));
      }
    }
  } finally { sweeping = false; }
}
