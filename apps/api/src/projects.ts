import { createEmptyTimeline, canvasFormats, editSchema, EditError } from "@editor/timeline";
import { and, desc, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { appOrigin, auth } from "./auth";
import { db } from "./db/client";
import { project, session as sessions } from "./db/schema";
import { getProject, HistoryError, saveEdit } from "./history";

const input = z.strictObject({ title: z.string().trim().min(1).max(120), format: z.enum(canvasFormats) });
export const projects = new Hono<{ Variables: { ownerId: string; sessionId: string } }>();

projects.use("*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user.emailVerified) return c.json({ error: "Sign in to open your projects." }, 401);
  c.set("ownerId", session.user.id);
  c.set("sessionId", session.session.id);
  if (c.req.method === "POST") {
    const origin = c.req.header("Origin");
    if ((origin && origin !== appOrigin) || c.req.header("Sec-Fetch-Site") === "cross-site") {
      return c.json({ error: "Open Cutroom to change a project." }, 403);
    }
    if (c.req.header("Content-Type")?.split(";")[0] !== "application/json") return c.json({ error: "Expected JSON." }, 415);
  }
  await next();
});

projects.get("/", async (c) => {
  const items = await db.select({ id: project.id, title: project.title, updatedAt: project.updatedAt })
    .from(project).where(eq(project.ownerId, c.get("ownerId")))
    .orderBy(desc(project.updatedAt), desc(project.id));
  return c.json(items);
});

projects.post("/", async (c) => {
  const result = input.safeParse(await c.req.json().catch(() => null));
  if (!result.success) return c.json({ error: "Enter a title (1–120 characters) and choose a canvas format." }, 400);
  const { title, format } = result.data;
  const id = crypto.randomUUID();
  await db.insert(project).values({ id, ownerId: c.get("ownerId"), title, formatVersion: 2, timeline: createEmptyTimeline(id, title, format) });
  return c.json({ id }, 201);
});

projects.get("/:id", async (c) => {
  const id = z.uuid().safeParse(c.req.param("id"));
  if (id.success) {
    const row = await getProject(id.data, c.get("ownerId"));
    if (row) return c.json(row);
  }
  return c.json({ error: "Project not found." }, 404);
});

projects.post("/:id/edits", async c => {
  const id = z.uuid().safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "Project not found." }, 404);
  const command = editSchema.safeParse(await c.req.json().catch(() => null));
  if (!command.success) return c.json({ error: "Invalid edit request." }, 400);
  try {
    return c.json(await saveEdit(id.data, c.get("ownerId"), command.data));
  } catch (error) {
    if (error instanceof HistoryError) return c.json({ error: error.message, revision: error.revision }, error.status);
    if (error instanceof EditError) return c.json({ error: error.message }, 422);
    throw error;
  }
});

projects.get("/:id/events", async c => {
  const id = z.uuid().safeParse(c.req.param("id"));
  if (!id.success) return c.json({ error: "Project not found." }, 404);
  const getRevision = async () => {
    const [row] = await db.select({ revision: project.revision }).from(project)
      .innerJoin(sessions, eq(sessions.userId, project.ownerId))
      .where(and(eq(project.id, id.data), eq(project.ownerId, c.get("ownerId")),
        eq(sessions.id, c.get("sessionId")), gt(sessions.expiresAt, new Date())));
    return row?.revision;
  };
  let current = await getRevision();
  if (current === undefined) return c.json({ error: "Project not found." }, 404);
  let seen = Number(c.req.header("Last-Event-ID") ?? c.req.query("since") ?? -1);
  c.header("X-Accel-Buffering", "no");
  const response = streamSSE(c, async stream => {
    await stream.write(": connected\n\n");
    let beats = 0;
    while (!stream.aborted) {
      if (current === undefined) { await stream.writeSSE({ event: "access-ended", data: "{}" }); break; }
      if (current !== seen) {
        await stream.writeSSE({ event: "revision", id: String(current), data: String(current) });
        seen = current;
      } else if (++beats % 8 === 0) await stream.write(": heartbeat\n\n");
      await stream.sleep(1500);
      if (!stream.aborted) current = await getRevision();
    }
  });
  // streamSSE sets its own cache header. Keep proxies from compressing and buffering revision notices.
  response.headers.set("Cache-Control", "private, no-store, no-transform");
  return response;
});
