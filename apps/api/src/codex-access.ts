import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "./db/client";
import { codexConnection, codexRun, project, projectEdit } from "./db/schema";
import { HistoryError, type EditTransaction } from "./history";

export const newProjectKey = () => "cut_" + randomBytes(32).toString("base64url");
export const digestKey = (raw: string) => createHash("sha256").update(raw).digest("hex");
const keyLifetime = 30 * 24 * 60 * 60_000;

export const connections = new Hono<{ Variables: { ownerId: string; sessionId: string } }>().basePath("/:id/connection");

connections.use("*", async (c, next) => {
  const id = c.req.param("id");
  if (!z.uuid().safeParse(id).success) return c.json({ error: "Project not found." }, 404);
  const [owned] = await db.select({ id: project.id }).from(project)
    .where(and(eq(project.id, id), eq(project.ownerId, c.get("ownerId"))));
  if (!owned) return c.json({ error: "Project not found." }, 404);
  c.header("Cache-Control", "private, no-store");
  await next();
});

connections.get("/", async c => {
  const [row] = await db.select({ expiresAt: codexConnection.expiresAt, lastUsedAt: codexConnection.lastUsedAt })
    .from(codexConnection).where(eq(codexConnection.projectId, c.req.param("id")));
  return c.json({ connected: !!row && row.expiresAt > new Date(), lastUsedAt: row?.lastUsedAt ?? null, expiresAt: row?.expiresAt ?? null });
});

connections.post("/", async c => {
  const key = newProjectKey(), expiresAt = new Date(Date.now() + keyLifetime);
  const values = { secretHash: digestKey(key), expiresAt, lastUsedAt: null };
  await db.insert(codexConnection).values({ projectId: c.req.param("id"), ...values })
    .onConflictDoUpdate({ target: codexConnection.projectId, set: values });
  return c.json({ connected: true, lastUsedAt: null, expiresAt, key }, 201);
});

connections.delete("/", async c => {
  await db.delete(codexConnection).where(eq(codexConnection.projectId, c.req.param("id")));
  return c.json({ connected: false, lastUsedAt: null, expiresAt: null });
});

export async function resolveProjectKey(header: string | undefined) {
  const match = /^Bearer (cut_[A-Za-z0-9_-]{43})$/i.exec(header ?? "");
  if (!match) return;
  const hash = digestKey(match[1]);
  const [external] = await db.select({ projectId: project.id, ownerId: project.ownerId })
    .from(codexConnection).innerJoin(project, eq(project.id, codexConnection.projectId))
    .where(and(eq(codexConnection.secretHash, hash), gt(codexConnection.expiresAt, new Date())));
  if (external) return { kind: "external" as const, ...external, hash };
  const [run] = await db.select({ projectId: project.id, ownerId: project.ownerId, id: codexRun.id, context: codexRun.context })
    .from(codexRun).innerJoin(project, and(eq(project.id, codexRun.projectId), eq(project.ownerId, codexRun.ownerId)))
    .where(and(eq(codexRun.tokenHash, hash), gt(codexRun.expiresAt, new Date()), eq(codexRun.status, "running")));
  if (run) return { kind: "run" as const, ...run, hash };
}

export type ProjectAccess = NonNullable<Awaited<ReturnType<typeof resolveProjectKey>>>;

export async function acknowledgeRead(access: ProjectAccess, revision: number) {
  if (access.kind === "run") await db.update(codexRun)
    .set({ lastReadRevision: sql`greatest(coalesce(${codexRun.lastReadRevision}, 0), ${revision})` })
    .where(and(eq(codexRun.id, access.id), eq(codexRun.tokenHash, access.hash), eq(codexRun.status, "running")));
}

export async function markConnected(access: ProjectAccess) {
  if (access.kind === "external") await db.update(codexConnection).set({ lastUsedAt: new Date() })
    .where(and(eq(codexConnection.projectId, access.projectId), eq(codexConnection.secretHash, access.hash)));
}

export async function selectionWasRemoved(access: Extract<ProjectAccess, { kind: "run" }>, revision: number, conn: EditTransaction | typeof db = db) {
  const { clipId, revision: captured } = access.context;
  if (!clipId || revision <= captured) return false;
  const [removed] = await conn.select({ revision: projectEdit.revision }).from(projectEdit)
    .where(and(eq(projectEdit.projectId, access.projectId), gt(projectEdit.revision, captured), lte(projectEdit.revision, revision),
      sql`(${projectEdit.forward}->'remove' ? ${clipId} or ${projectEdit.command}->'operations' @>
        ${JSON.stringify([{ type: "add", clip: { id: clipId } }])}::jsonb)`)).limit(1);
  return Boolean(removed);
}

// Serialize a project edit with Stop, key rotation or revocation in the same database transaction.
export async function authorizeProjectAccess(tx: EditTransaction, access: ProjectAccess) {
  if (access.kind === "external") {
    const [key] = await tx.select({ id: codexConnection.projectId }).from(codexConnection)
      .where(and(eq(codexConnection.projectId, access.projectId), eq(codexConnection.secretHash, access.hash), gt(codexConnection.expiresAt, new Date()))).for("update");
    if (!key) throw new HistoryError(409, "The project connection has ended.");
    return;
  }
  const [run] = await tx.select({ context: codexRun.context, read: codexRun.lastReadRevision, receipt: codexRun.receipt }).from(codexRun)
    .where(and(eq(codexRun.id, access.id), eq(codexRun.tokenHash, access.hash), eq(codexRun.status, "running"), gt(codexRun.expiresAt, new Date()))).for("update");
  if (!run) throw new HistoryError(409, "The Codex turn has ended.");
  return run;
}

export async function authorizeEdit(tx: EditTransaction, access: ProjectAccess, clipId: string, revision: number) {
  const run = await authorizeProjectAccess(tx, access);
  if (!run) return;
  if (!run.context.clipId || clipId !== run.context.clipId) throw new HistoryError(422, "Choose the selected title captured for this turn.");
  if (!run.receipt && revision !== run.context.revision && revision !== run.read) throw new HistoryError(409, "Read the current project before rebasing the title edit.");
}
