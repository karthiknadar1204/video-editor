import { EditError, roughCutOptionsSchema } from "@editor/timeline";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { AllowanceError } from "./allowance";
import { HistoryError } from "./history";
import { commitRoughCut, getRoughCut, listRoughCuts, previewRoughCut, restoreRoughPassage, undoReview } from "./rough-cuts";

const owner = (projectId: string, ownerId: string) => ({ projectId, ownerId });
const requestId = z.uuid(), expectedRevision = z.int().nonnegative();
const preview = z.strictObject({ requestId, options: roughCutOptionsSchema });
const commit = z.strictObject({ expectedRevision });
const undo = z.strictObject({ requestId, expectedRevision });
const restore = undo.extend({ cutId: z.string().min(1).max(200) });
export const roughCutRoutes = new Hono<{ Variables: { ownerId: string } }>().basePath("/:id/rough-cuts");

roughCutRoutes.use("*", bodyLimit({ maxSize: 64 * 1024 }));
roughCutRoutes.use("*", async (c, next) => {
  if (!z.uuid().safeParse(c.req.param("id")).success) return c.json({ error: "Project not found." }, 404);
  await next();
});
roughCutRoutes.use("/:reviewId/*", async (c, next) => {
  if (!z.uuid().safeParse(c.req.param("reviewId")).success) return c.json({ error: "Review not found." }, 404);
  await next();
});
roughCutRoutes.onError((error, c) => {
  if (error instanceof HistoryError) return c.json({ error: error.message, revision: error.revision }, error.status);
  if (error instanceof EditError) return c.json({ error: error.message }, 422);
  if (error instanceof AllowanceError) return c.json({ error: error.message }, 429);
  console.error("Rough cut request failed", error.name);
  return c.json({ error: "Could not open this review." }, 503);
});
roughCutRoutes.get("/", async c => c.json({ reviews: await listRoughCuts(owner(c.req.param("id"), c.get("ownerId"))) }));
roughCutRoutes.get("/:reviewId", async c => c.json(await getRoughCut(owner(c.req.param("id"), c.get("ownerId")), c.req.param("reviewId"))));
roughCutRoutes.post("/", async c => {
  const body = preview.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Choose a clip or timeline range and valid rough-cut settings." }, 400);
  return c.json(await previewRoughCut(owner(c.req.param("id"), c.get("ownerId")), body.data.options, body.data.requestId), 201);
});
roughCutRoutes.post("/:reviewId/commit", async c => {
  const body = commit.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Choose a reviewed revision." }, 400);
  return c.json(await commitRoughCut(owner(c.req.param("id"), c.get("ownerId")), c.req.param("reviewId"), body.data.expectedRevision));
});
roughCutRoutes.post("/:reviewId/restore", async c => {
  const body = restore.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Choose the passage to restore." }, 400);
  return c.json(await restoreRoughPassage(owner(c.req.param("id"), c.get("ownerId")), c.req.param("reviewId"), body.data.cutId, body.data.expectedRevision, body.data.requestId));
});
roughCutRoutes.post("/:reviewId/undo", async c => {
  const body = undo.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Choose the saved edit to undo." }, 400);
  return c.json(await undoReview(owner(c.req.param("id"), c.get("ownerId")), c.req.param("reviewId"), body.data.expectedRevision, body.data.requestId));
});
