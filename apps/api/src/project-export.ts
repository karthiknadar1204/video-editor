import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { rushes, sample, type Timeline } from "@editor/timeline";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { streamText } from "hono/streaming";
import { z } from "zod";
import { projectExportDir, workerDir } from "../../worker/paths";
import { getProject } from "./history";
import { db } from "./db/client";
import { projectAsset } from "./db/schema";
import { originalName } from "./media";
import { serveAsset } from "./media-storage";

export async function renderSequence(write: (chunk: Uint8Array) => Promise<unknown>, job?: string) {
  const worker = Bun.spawn(["node", "--import", "tsx", "src/render.ts"], {
    cwd: workerDir, stdout: "pipe", stderr: "inherit",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      REMOTION_BROWSER_EXECUTABLE: process.env.REMOTION_BROWSER_EXECUTABLE,
      CUTROOM_RENDER_DIR: process.env.CUTROOM_RENDER_DIR, CUTROOM_RENDER_JOB: job },
  });
  for await (const chunk of worker.stdout) await write(chunk);
  if (await worker.exited !== 0) throw new Error("The render worker could not finish this export.");
}

// Materialize referenced originals inside the render job so the renderer needs no credentials.
async function prepareProject(job: string, projectId: string, timeline: Timeline) {
  await mkdir(join(job, "assets"));
  const used = new Set(timeline.clips.flatMap(c => c.kind === "media" ? [c.assetId] : []));
  const assets = [];
  for (const asset of timeline.assets.filter(a => used.has(a.id))) {
    if ([sample, rushes].some(bundled => asset.src === bundled.src)) {
      assets.push(asset);
      continue;
    }
    const assetId = z.uuid().safeParse(asset.id);
    const [row] = assetId.success ? await db.select().from(projectAsset).where(and(eq(projectAsset.id, assetId.data),
      eq(projectAsset.projectId, projectId), eq(projectAsset.state, "ready"))) : [];
    if (!row) throw new Error("Unknown source for " + asset.name);
    let response = await serveAsset(row, "original", undefined);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const target = new URL(response.headers.get("Location") ?? "");
      if (target.protocol !== "https:") throw new Error("Invalid original media location.");
      response = await fetch(target, { redirect: "error", signal: AbortSignal.timeout(90_000) });
    }
    if (!response.ok || !response.body) throw new Error("Could not open the original media for " + asset.name);
    const filename = asset.id + extname(originalName(row.mime));
    await Bun.write(join(job, "assets", filename), response);
    assets.push({ ...asset, src: "imports/" + filename });
  }
  await writeFile(join(job, "timeline.json"), JSON.stringify({ ...timeline, assets }));
}

export const projectExports = new Hono<{ Variables: { ownerId: string } }>();
const revisionSchema = z.int().nonnegative();
let rendering = false;

projectExports.post("/:id/export", async c => {
  const id = z.uuid().safeParse(c.req.param("id"));
  const project = id.success && await getProject(id.data, c.get("ownerId"));
  if (!project) return c.json({ error: "Project not found." }, 404);
  const command = z.strictObject({ revision: revisionSchema }).safeParse(await c.req.json().catch(() => null));
  if (!command.success) return c.json({ error: "Choose a saved revision to export." }, 400);
  if (project.revision !== command.data.revision) return c.json({ error: "The project changed. Load its latest revision before exporting." }, 409);
  if (!project.timeline.durationInFrames) return c.json({ error: "Add a clip before exporting." }, 422);
  const directory = projectExportDir(project.id);
  const output = join(directory, project.revision + ".mp4");
  if (await Bun.file(output).exists()) return c.text("Ready\n");
  if (rendering) return c.json({ error: "An export is running. Try again when it finishes." }, 409);
  rendering = true;
  c.header("Cache-Control", "private, no-store, no-transform");
  c.header("X-Accel-Buffering", "no");
  return streamText(c, async stream => {
    let job: string | undefined;
    try {
      await stream.writeln("Preparing");
      await mkdir(directory, { recursive: true });
      job = await mkdtemp(join(directory, "render-"));
      await prepareProject(job, project.id, project.timeline);
      await renderSequence(chunk => stream.write(chunk), job);
      await rename(join(job, "output.mp4"), output);
      await stream.writeln("Ready");
    } catch {
      await stream.writeln("Failed");
    } finally {
      rendering = false;
      if (job) await rm(job, { recursive: true, force: true });
    }
  });
});

projectExports.get("/:id/export", async c => {
  const id = z.uuid().safeParse(c.req.param("id"));
  const project = id.success && await getProject(id.data, c.get("ownerId"));
  if (!project) return c.json({ error: "Project not found." }, 404);
  const revision = z.string().regex(/^\d+$/).transform(Number).pipe(revisionSchema).safeParse(c.req.query("revision"));
  if (!revision.success) return c.json({ error: "Choose an export revision." }, 400);
  const file = Bun.file(join(projectExportDir(project.id), revision.data + ".mp4"));
  if (!(await file.exists())) return c.json({ error: "Export not found." }, 404);
  return new Response(file, { headers: { "Content-Type": "video/mp4", "Cache-Control": "private, no-store",
    "Content-Disposition": 'attachment; filename="cutroom.mp4"; filename*=UTF-8\'\'' + encodeURIComponent(project.title + ".mp4").replaceAll("'", "%27") } });
});
