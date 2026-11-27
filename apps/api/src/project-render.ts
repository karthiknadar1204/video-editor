import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { rushes, sample, type Timeline } from "@editor/timeline";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { workerDir } from "../../worker/paths";
import { db } from "./db/client";
import { projectAsset } from "./db/schema";
import { originalName } from "./media";
import { stageOriginal } from "./media-storage";

export class MissingSource extends Error {}

export function renderProgress(update: (percent: number) => void | Promise<void>) {
  const decoder = new TextDecoder();
  let pending = "", last = 0;
  return async (chunk: Uint8Array) => {
    const lines = (pending + decoder.decode(chunk, { stream: true })).split("\n");
    pending = lines.pop() ?? "";
    const percent = Math.min(99, Math.max(last, ...lines.filter(line => /^\d{1,3}$/.test(line)).map(Number)));
    if (percent >= last + 5) {
      last = percent;
      await update(percent);
    }
  };
}

export async function renderSequence(write: (chunk: Uint8Array) => Promise<unknown>, job?: string, options?: { frame?: number; signal?: AbortSignal; bundle?: string; freeze?: string }) {
  const worker = Bun.spawn(["node", "--import", "tsx", "src/render.ts"], {
    cwd: workerDir, stdout: "pipe", stderr: "inherit", signal: options?.signal, killSignal: "SIGKILL",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      REMOTION_BROWSER_EXECUTABLE: process.env.REMOTION_BROWSER_EXECUTABLE,
      CUTROOM_RENDER_DIR: process.env.CUTROOM_RENDER_DIR, CUTROOM_RENDER_JOB: job, CUTROOM_RENDER_FRAME: options?.frame?.toString(),
      CUTROOM_RENDER_BUNDLE: options?.bundle, CUTROOM_FREEZE_BUNDLE: options?.freeze },
  });
  try {
    for await (const chunk of worker.stdout) await write(chunk);
  } catch (error) {
    worker.kill("SIGKILL");
    await worker.exited;
    throw error;
  }
  if (await worker.exited !== 0) throw new Error("The render worker could not finish this export.");
}

// Materialize referenced originals inside the render job so the renderer needs no credentials.
export async function prepareProject(job: string, projectId: string, timeline: Timeline, signal?: AbortSignal) {
  await mkdir(join(job, "assets"));
  const used = new Set(timeline.clips.flatMap(c => c.kind === "media" ? [c.assetId] : []));
  const assets = [];
  for (const asset of timeline.assets.filter(a => used.has(a.id))) {
    signal?.throwIfAborted();
    if ([sample, rushes].some(bundled => asset.src === bundled.src)) {
      assets.push(asset);
      continue;
    }
    const assetId = z.uuid().safeParse(asset.id);
    const [row] = assetId.success ? await db.select().from(projectAsset).where(and(eq(projectAsset.id, assetId.data),
      eq(projectAsset.projectId, projectId), eq(projectAsset.state, "ready"))) : [];
    if (!row) throw new MissingSource("Missing source media: " + asset.name);
    const filename = asset.id + extname(originalName(row.mime));
    try { await stageOriginal(row, join(job, "assets", filename), signal); }
    catch { signal?.throwIfAborted(); throw new MissingSource("Could not read source media: " + asset.name); }
    assets.push({ ...asset, src: "imports/" + filename });
  }
  await writeFile(join(job, "timeline.json"), JSON.stringify({ ...timeline, assets }));
}

