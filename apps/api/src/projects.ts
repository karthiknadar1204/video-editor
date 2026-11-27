import { createEmptyTimeline, canvasFormats } from "@editor/timeline";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { appOrigin, auth } from "./auth";
import { db } from "./db/client";
import { project } from "./db/schema";

const input = z.strictObject({ title: z.string().trim().min(1).max(120), format: z.enum(canvasFormats) });
export const projects = new Hono<{ Variables: { ownerId: string } }>();

projects.use("*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user.emailVerified) return c.json({ error: "Sign in to open your projects." }, 401);
  c.set("ownerId", session.user.id);
  await next();
});

projects.get("/", async (c) => {
  const items = await db.select({ id: project.id, title: project.title, updatedAt: project.updatedAt })
    .from(project).where(eq(project.ownerId, c.get("ownerId")))
    .orderBy(desc(project.updatedAt), desc(project.id));
  return c.json(items);
});

projects.post("/", async (c) => {
  const origin = c.req.header("Origin");
  if ((origin && origin !== appOrigin) || c.req.header("Sec-Fetch-Site") === "cross-site") {
    return c.json({ error: "Open Cutroom to create a project." }, 403);
  }
  if (c.req.header("Content-Type")?.split(";")[0] !== "application/json") {
    return c.json({ error: "Expected a JSON project." }, 415);
  }
  const result = input.safeParse(await c.req.json().catch(() => null));
  if (!result.success) return c.json({ error: "Enter a title (1–120 characters) and choose a canvas format." }, 400);
  const { title, format } = result.data;
  const id = crypto.randomUUID();
  await db.insert(project).values({ id, ownerId: c.get("ownerId"), title, timeline: createEmptyTimeline(id, title, format) });
  return c.json({ id }, 201);
});

projects.get("/:id", async (c) => {
  const id = z.uuid().safeParse(c.req.param("id"));
  if (id.success) {
    const [row] = await db.select({
      id: project.id, title: project.title, timeline: project.timeline,
      formatVersion: project.formatVersion, revision: project.revision,
    }).from(project).where(and(eq(project.id, id.data), eq(project.ownerId, c.get("ownerId"))));
    if (row) return c.json(row);
  }
  return c.json({ error: "Project not found." }, 404);
});
