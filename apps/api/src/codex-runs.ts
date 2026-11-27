import { readTimeline, turnInput } from "@editor/timeline";
import { and, desc, eq, gt, lte } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { runCodex, RunnerError } from "../../runner/src/client";
import { AllowanceError, takeAllowance } from "./allowance";
import { digestKey, newProjectKey } from "./codex-access";
import { addActivity, finishRun, publicRunFields } from "./codex-runs-store";
import { db } from "./db/client";
import { codexRun, project, session } from "./db/schema";
import { HistoryError } from "./history";

type Run = typeof codexRun.$inferSelect;
const active = new Map<string, AbortController>();
const maxRunMs = 10 * 60_000;
const ownerProject = (owner: string, id: string) => and(eq(codexRun.ownerId, owner), eq(codexRun.projectId, id));
export const runs = new Hono<{ Variables: { ownerId: string; sessionId: string } }>().basePath("/:id/runs");
runs.use("*", async (c, next) => {
  if (!z.uuid().safeParse(c.req.param("id")).success) return c.json({ error: "Project not found." }, 404);
  const [owned] = await db
    .select({ id: project.id })
    .from(project)
    .where(and(eq(project.id, c.req.param("id")), eq(project.ownerId, c.get("ownerId"))));
  if (!owned) return c.json({ error: "Project not found." }, 404);
  await db
    .update(codexRun)
    .set({ status: "failed", result: "This turn expired. Any saved edit is in history." })
    .where(
      and(
        ownerProject(c.get("ownerId"), owned.id),
        eq(codexRun.status, "running"),
        lte(codexRun.expiresAt, new Date()),
      ),
    );
  await next();
});
runs.onError((err, c) => {
  if (err instanceof AllowanceError || err instanceof HistoryError)
    return c.json({ error: err.message }, err.status);
  console.error("Codex run request failed", err.name);
  return c.json({ error: "Could not open the Codex conversation." }, 503);
});

async function execute(run: Run, token: string) {
  const controller = new AbortController();
  active.set(run.id, controller);
  const deadline = setTimeout(() => controller.abort(), Math.max(1, run.expiresAt.getTime() - Date.now()));
  const stoppedElsewhere = setInterval(() => {
    void db
      .select({ status: codexRun.status })
      .from(codexRun)
      .where(eq(codexRun.id, run.id))
      .then(([r]) => {
        if (r?.status !== "running") controller.abort();
      })
      .catch(() => controller.abort());
  }, 1500);
  try {
    const previous = await db
      .select({ prompt: codexRun.prompt, result: codexRun.result, receipt: codexRun.receipt })
      .from(codexRun)
      .where(
        and(
          ownerProject(run.ownerId, run.projectId),
          eq(codexRun.tabId, run.tabId),
          eq(codexRun.status, "completed"),
        ),
      )
      .orderBy(desc(codexRun.createdAt))
      .limit(4);
    const mcpUrl = "http://127.0.0.1:" + (process.env.API_PORT ?? "4000") + "/api/mcp";
    const final = await runCodex({
      ownerId: run.ownerId,
      projectId: run.projectId,
      runId: run.id,
      prompt: run.prompt,
      context: { ...run.context, previous: previous.reverse() },
      mcpUrl,
      token,
      signal: controller.signal,
      onEvent: (message: string) => addActivity(run.id, message),
    });
    await finishRun(run.id, "completed", final);
  } catch (error) {
    const reason = controller.signal.aborted
      ? "This turn was interrupted. Any saved edit is shown below."
      : error instanceof RunnerError
        ? error.message
        : "Could not finish this turn. Check the private runner connection.";
    await finishRun(run.id, "failed", reason);
  } finally {
    clearInterval(stoppedElsewhere);
    clearTimeout(deadline);
    active.delete(run.id);
  }
}

runs.post("/", async (c) => {
  const input = turnInput.safeParse(await c.req.json().catch(() => null));
  if (!input.success)
    return c.json({ error: "Send a request with its editor selection and saved revision." }, 400);
  const { id, prompt, context } = input.data,
    projectId = c.req.param("id"),
    ownerId = c.get("ownerId");
  const token = newProjectKey();
  const inserted = await db.transaction(async (tx) => {
    const [p] = await tx
      .select()
      .from(project)
      .where(and(eq(project.id, projectId), eq(project.ownerId, ownerId)))
      .for("update");
    if (!p) throw new HistoryError(404, "Project not found.");
    const [prior] = await tx
      .select()
      .from(codexRun)
      .where(and(ownerProject(ownerId, projectId), eq(codexRun.id, id)));
    if (prior) {
      if (
        prior.prompt !== prompt ||
        prior.tabId !== context.tabId ||
        prior.context.clipId !== context.clipId ||
        prior.context.frame !== context.frame ||
        prior.context.revision !== context.revision ||
        prior.context.range?.from !== context.range?.from ||
        prior.context.range?.to !== context.range?.to
      )
        throw new HistoryError(409, "This request ID already belongs to another turn.");
      return false;
    }
    const timeline = readTimeline(p.formatVersion, p.timeline);
    if (
      p.revision !== context.revision ||
      (context.clipId && !timeline.clips.some((clip) => clip.id === context.clipId))
    )
      throw new HistoryError(409, "The selection changed. Load the latest revision and choose the title again.");
    if (
      context.frame >= Math.max(1, timeline.durationInFrames) ||
      (context.range && context.range.to > timeline.durationInFrames)
    )
      throw new HistoryError(422, "The playhead or range falls outside this sequence.");
    const [busy] = await tx
      .select({ id: codexRun.id })
      .from(codexRun)
      .where(
        and(ownerProject(ownerId, projectId), eq(codexRun.tabId, context.tabId), eq(codexRun.status, "running")),
      );
    if (busy) throw new HistoryError(409, "A turn is already running in this editor tab.");
    await takeAllowance(ownerId, "turn", tx);
    const [row] = await tx
      .insert(codexRun)
      .values({
        id,
        ownerId,
        projectId,
        tabId: context.tabId,
        prompt,
        context,
        status: "running",
        tokenHash: digestKey(token),
        expiresAt: new Date(Date.now() + maxRunMs),
      })
      .returning();
    return row;
  });
  if (inserted) void execute(inserted, token).catch(() => console.error("Could not close the Codex turn."));
  return c.json({ id }, inserted ? 201 : 200);
});
runs.get("/", async (c) => {
  const tab = z.uuid().safeParse(c.req.query("tabId"));
  if (!tab.success) return c.json({ error: "Choose an editor tab." }, 400);
  const list = await db
    .select(publicRunFields)
    .from(codexRun)
    .where(and(ownerProject(c.get("ownerId"), c.req.param("id")), eq(codexRun.tabId, tab.data)))
    .orderBy(desc(codexRun.createdAt))
    .limit(12);
  return c.json(list.reverse());
});
runs.delete("/:runId", async (c) => {
  if (!z.uuid().safeParse(c.req.param("runId")).success) return c.json({ error: "Run not found." }, 404);
  const where = and(ownerProject(c.get("ownerId"), c.req.param("id")), eq(codexRun.id, c.req.param("runId")));
  const [row] = await db.select({ id: codexRun.id }).from(codexRun).where(where);
  if (!row) return c.json({ error: "Run not found." }, 404);
  await finishRun(row.id, "stopped", "Stopped. Any edit already saved is in project history.");
  active.get(row.id)?.abort();
  return c.body(null, 204);
});
runs.get("/:runId", async (c) => {
  const id = z.uuid().safeParse(c.req.param("runId"));
  if (!id.success) return c.json({ error: "Run not found." }, 404);
  const read = async () => {
    const [run] = await db
      .select(publicRunFields)
      .from(codexRun)
      .innerJoin(
        session,
        and(
          eq(session.userId, codexRun.ownerId),
          eq(session.id, c.get("sessionId")),
          gt(session.expiresAt, new Date()),
        ),
      )
      .where(and(ownerProject(c.get("ownerId"), c.req.param("id")), eq(codexRun.id, id.data)));
    return run;
  };
  let run = await read();
  if (!run) return c.json({ error: "Run not found." }, 404);
  if (!c.req.header("Accept")?.includes("text/event-stream")) return c.json(run);
  c.header("X-Accel-Buffering", "no");
  const response = streamSSE(c, async (stream) => {
    let last = "",
      beats = 0;
    while (!stream.aborted) {
      if (!run) {
        await stream.writeSSE({ event: "access-ended", data: "{}" });
        break;
      }
      const data = JSON.stringify(run);
      if (data !== last) {
        await stream.writeSSE({ event: "run", data });
        last = data;
      } else if (++beats % 12 === 0) await stream.write(": heartbeat\n\n");
      if (run.status !== "running") break;
      await stream.sleep(700);
      if (!stream.aborted) run = await read();
    }
  });
  response.headers.set("Cache-Control", "private, no-store, no-transform");
  return response;
});
