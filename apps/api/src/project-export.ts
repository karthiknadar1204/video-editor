import { join } from "node:path";
import { Hono } from "hono";
import { streamText } from "hono/streaming";
import { z } from "zod";
import { projectExportDir } from "../../worker/paths";
import { AllowanceError } from "./allowance";
import { changeAttempt, changeShare, completedVersion, ExportError, getExport, listExports, startExport } from "./export-jobs";
import { streamOutput } from "./export-storage";
import { editHistory, getProject } from "./history";
import { serveLocalFile } from "./media-storage";

export { prepareProject, renderSequence } from "./project-render";
export const projectExports = new Hono<{ Variables: { ownerId: string } }>();
export const publicWatch = new Hono();
const number = z.int().nonnegative().max(2_147_483_647);
const body = z.strictObject({ revision: number });

projectExports.use("/:id/exports/*", async (c, next) => {
  if (!z.uuid().safeParse(c.req.param("id")).success) return c.json({ error: "Project not found." }, 404);
  await next();
});
projectExports.onError((e, c) => {
  if (e instanceof ExportError || e instanceof AllowanceError) return c.json({ error: e.message }, e.status);
  return c.json({ error: "Could not access this export. Try again." }, 503);
});

projectExports.post("/:id/export", async c => {
  const input = body.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json({ error: "Choose a saved revision to export." }, 400);
  const owner = { ownerId: c.get("ownerId"), projectId: c.req.param("id") };
  const saved = await startExport({ ...owner, ...input.data });
  if (c.req.header("Accept")?.includes("application/json")) return c.json(saved);
  c.header("Cache-Control", "private, no-store, no-transform");
  c.header("X-Accel-Buffering", "no");
  return streamText(c, async stream => {
    let row = saved, previous = "";
    while (!stream.aborted) {
      const label = row.status === "completed" ? "Ready" : ["failed", "cancelled"].includes(row.status) ? "Failed" :
        row.status === "queued" ? "Preparing" : String(row.progress);
      if (label !== previous) { await stream.writeln(label); previous = label; }
      if (label === "Ready" || label === "Failed") return;
      await stream.sleep(700);
      if (!stream.aborted) row = await getExport({ ...owner, exportId: row.id });
    }
  });
});
projectExports.get("/:id/export", async c => {
  const revision = z.string().regex(/^\d+$/).transform(Number).pipe(number).safeParse(c.req.query("revision"));
  if (!revision.success) return c.json({ error: "Choose an export revision." }, 400);
  const target = { ownerId: c.get("ownerId"), projectId: c.req.param("id"), revision: revision.data };
  try {
    const version = await completedVersion(target);
    return await streamOutput(version, version.attempt, c.req.raw, true);
  } catch (e) {
    if (!(e instanceof ExportError) || e.status !== 404) throw e;
    const p = z.uuid().safeParse(target.projectId).success && await getProject(target.projectId, target.ownerId);
    if (!p) throw e;
    const file = join(projectExportDir(p.id), revision.data + ".mp4");
    if (!await Bun.file(file).exists()) throw e;
    return serveLocalFile(file, new Headers({ "Content-Type": "video/mp4", "Cache-Control": "private, no-store",
      "Content-Disposition": "attachment; filename=\"cutroom.mp4\"; filename*=UTF-8''" + encodeURIComponent(p.title + ".mp4").replaceAll("'", "%27") }), c.req.header("Range"));
  }
});

projectExports.get("/:id/exports", async c => {
  const offset = number.safeParse(Number(c.req.query("offset") ?? 0));
  if (!offset.success) return c.json({ error: "Invalid page." }, 400);
  return c.json(await listExports({ projectId: c.req.param("id"), ownerId: c.get("ownerId") }, offset.data));
});
projectExports.get("/:id/exports/:exportId", async c => c.json(await getExport({ ownerId: c.get("ownerId"), projectId: c.req.param("id"), exportId: c.req.param("exportId") })));
projectExports.get("/:id/exports/:exportId/edits", async c => {
  const projectId = c.req.param("id");
  const version = await getExport({ ownerId: c.get("ownerId"), projectId, exportId: c.req.param("exportId") });
  const through = number.safeParse(Number(c.req.query("through") ?? version.revision));
  if (!through.success || through.data > version.revision) return c.json({ error: "Choose a revision within this export." }, 400);
  const entries = await editHistory(projectId, through.data, 21);
  return c.json({ edits: entries.slice(0, 20), nextRevision: entries[20]?.revision ?? null });
});
projectExports.get("/:id/exports/:exportId/file", async c => {
  const v = await completedVersion({ ownerId: c.get("ownerId"), projectId: c.req.param("id"), exportId: c.req.param("exportId") });
  return streamOutput(v, v.attempt, c.req.raw, true);
});
projectExports.delete("/:id/exports/:exportId", async c => {
  const n = z.coerce.number().int().positive().safeParse(c.req.query("attempt"));
  if (!n.success) return c.json({ error: "Choose an export attempt." }, 400);
  return c.json(await changeAttempt({ ownerId: c.get("ownerId"), projectId: c.req.param("id"), exportId: c.req.param("exportId") }, "cancel", n.data));
});
projectExports.post("/:id/exports/:exportId/retry", async c => {
  const n = z.strictObject({ attempt: z.int().positive() }).safeParse(await c.req.json().catch(() => null));
  if (!n.success) return c.json({ error: "Choose an export attempt." }, 400);
  return c.json(await changeAttempt({ ownerId: c.get("ownerId"), projectId: c.req.param("id"), exportId: c.req.param("exportId") }, "retry", n.data.attempt));
});
projectExports.on(["POST", "DELETE"], "/:id/exports/:exportId/share", async c => c.json(await changeShare({
  ownerId: c.get("ownerId"), projectId: c.req.param("id"), exportId: c.req.param("exportId"),
}, c.req.method === "POST")));

publicWatch.use("*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Robots-Tag", "noindex, nofollow, noarchive");
  await next();
});
publicWatch.onError((e, c) => c.json({ error: "This watch link is unavailable." }, e instanceof ExportError && e.status === 404 ? 404 : 503));
publicWatch.get("/:token", async c => {
  const v = await completedVersion({ token: c.req.param("token") });
  return c.json({ title: v.title, revision: v.revision });
});
publicWatch.get("/:token/media", async c => {
  const v = await completedVersion({ token: c.req.param("token") });
  return streamOutput(v, v.attempt, c.req.raw, false);
});
