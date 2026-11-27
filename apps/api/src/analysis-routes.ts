import { wordCorrectionSchema } from "@editor/timeline";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { inspectSource, readTranscript, retryAnalysis, searchTranscripts, updateTranscript } from "./analysis";
import { MediaError } from "./media";

export const analysisRoutes = new Hono<{ Variables: { ownerId: string } }>();
const path = "/:id/assets/:assetId/analysis";
const revision = z.int().nonnegative();
const update = z.union([z.strictObject({ revision, subtitles: z.string().min(1).max(1_000_000) }),
  z.strictObject({ revision, index: revision, correction: wordCorrectionSchema })]);
const filters = { clipId: z.string().min(1).max(200).optional(), offset: revision.optional() };
const search = z.union([z.strictObject({ ...filters, phrase: z.string().trim().min(1).max(500), assetId: z.string().min(1).max(200).optional() }),
  z.strictObject({ ...filters, assetId: z.string().min(1).max(200), startMs: revision, endMs: revision }).refine(input => input.endMs > input.startMs)]);
const access = (projectId: string, ownerId: string) => ({ projectId, ownerId });
const missing = { error: "Source not found." };

function analysisFailure(error: unknown) {
  for (let cause = error, depth = 0; cause && typeof cause === "object" && depth < 5; depth++) {
    const code = "code" in cause ? cause.code : null;
    if (typeof code === "string") {
      if (/^08[0-9A-Z]{3}$/.test(code) || ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN",
        "CONNECT_TIMEOUT", "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED", "57P01", "57P02", "57P03", "53300"].includes(code)) return "database_connection";
      if (["40001", "40P01", "55P03"].includes(code)) return "transaction_contention";
      if (code.startsWith("23")) return "database_constraint";
    }
    cause = "cause" in cause ? cause.cause : null;
  }
  return "analysis_unexpected";
}

analysisRoutes.onError((error, c) => {
  if (error instanceof MediaError) return c.json({ error: error.message }, error.status);
  const code = analysisFailure(error);
  console.error("Footage analysis request failed", code);
  return c.json({ error: "Source analysis is temporarily unavailable.", code }, 503);
});

analysisRoutes.get(path, async c => {
  const query = z.object({ offset: z.coerce.number().int().nonnegative().default(0), view: z.enum(["active", "original", "imported"]).default("active") }).safeParse(c.req.query());
  if (!query.success) return c.json({ error: "Invalid transcript page." }, 400);
  const result = await readTranscript(access(c.req.param("id"), c.get("ownerId")), c.req.param("assetId"), query.data.offset, query.data.view);
  return result ? c.json(result) : c.json(missing, 404);
});

analysisRoutes.get("/:id/assets/:assetId/analysis/sheet", async c => {
  const data = await inspectSource(access(c.req.param("id"), c.get("ownerId")), c.req.param("assetId"));
  if (!data?.jpeg) return c.json({ error: "Source sheet unavailable." }, 404);
  return new Response(new Uint8Array(data.jpeg), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store" } });
});

analysisRoutes.put(path, bodyLimit({ maxSize: 2_000_000 }), async c => {
  const body = update.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Choose a subtitle file or a word to correct." }, 400);
  await updateTranscript(access(c.req.param("id"), c.get("ownerId")), c.req.param("assetId"), body.data);
  return c.body(null, 204);
});

analysisRoutes.post(path, async c => {
  const found = await retryAnalysis(access(c.req.param("id"), c.get("ownerId")), c.req.param("assetId"));
  return found ? c.body(null, 202) : c.json(missing, 404);
});

analysisRoutes.post("/:id/transcript-search", bodyLimit({ maxSize: 8_192 }), async c => {
  const body = search.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Enter a phrase or a source time range." }, 400);
  const result = await searchTranscripts(access(c.req.param("id"), c.get("ownerId")), body.data);
  return result ? c.json(result) : c.json({ error: "Project not found." }, 404);
});
