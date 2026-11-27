import { readTimeline } from "@editor/timeline";
import { and, eq, lt, ne } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "./db/client";
import { project, projectAsset } from "./db/schema";
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
  const [claim] = await db.update(projectAsset).set({ state: "processing" }).where(and(byAsset(row), eq(projectAsset.state, "pending"))).returning({ id: projectAsset.id });
  if (!claim) throw new MediaError("This media is being processed. Retry shortly.", 409);
  try {
    // All supported project formats run at 30 fps. Take the actual project rate for imported media.
    const [source] = await db.select({ version: project.formatVersion, timeline: project.timeline }).from(project).where(eq(project.id, row.projectId));
    const fps = readTimeline(source.version, source.timeline).fps;
    const asset = await processUpload(row, data.data.fileId, path(row), fps);
    await db.transaction(async tx => {
      const [ready] = await tx.update(projectAsset).set({ state: "ready", asset }).where(and(byAsset(row), eq(projectAsset.state, "processing"))).returning({ id: projectAsset.id });
      if (!ready) throw new MediaError("Upload cancelled.", 409);
      const [current] = await tx.select().from(project).where(and(eq(project.id, row.projectId), eq(project.ownerId, c.get("ownerId")))).for("update");
      if (!current) throw new MediaError("Project not found.", 404);
      const timeline = readTimeline(current.formatVersion, current.timeline);
      timeline.assets.push(asset);
      await tx.update(project).set({ timeline, formatVersion: 2, revision: current.revision + 1, updatedAt: new Date() }).where(eq(project.id, current.id));
    });
    return c.json(asset);
  } catch (error) {
    await db.update(projectAsset).set({ state: "pending" }).where(and(byAsset(row), eq(projectAsset.state, "processing")));
    throw error;
  }
});

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
      const [claimed] = await db.update(projectAsset).set({ state: "cancelled" })
        .where(and(byAsset(row), ne(projectAsset.state, "ready"), lt(projectAsset.expiresAt, until))).returning();
      if (claimed) {
        await removeAbandoned(claimed);
        await db.delete(projectAsset).where(and(byAsset(row), eq(projectAsset.state, "cancelled")));
      }
    }
  } finally { sweeping = false; }
}

function sweep() { void cleanExpiredUploads().catch(() => console.error("Expired media cleanup will retry.")); }
setTimeout(sweep, 1_000).unref();
setInterval(sweep, 15 * 60_000).unref();
