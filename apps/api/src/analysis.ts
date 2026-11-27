import { correctWord, lookupTranscript, mapSourceRange, parseSubtitles, readTimeline, type TranscriptMatch, type SourcePlacement, type WordCorrection } from "@editor/timeline";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { analysisVersion, jobKey } from "./analysis-worker";
import { db } from "./db/client";
import { project, sourceAnalysis as jobs, sourceTranscript as edits } from "./db/schema";
import { enqueueMedia } from "./queue";
import { MediaError } from "./media";

type Access = { projectId: string; ownerId: string };
async function owned({ projectId, ownerId }: Access) {
  if (!z.uuid().safeParse(projectId).success) return null;
  const [p] = await db.select({ version: project.formatVersion, revision: project.revision, timeline: project.timeline }).from(project)
    .where(and(eq(project.id, projectId), eq(project.ownerId, ownerId)));
  return p && { revision: p.revision, timeline: readTimeline(p.version, p.timeline) };
}

const joined = and(eq(edits.projectId, jobs.projectId), eq(edits.assetId, jobs.assetId));
const editKey = (projectId: string, assetId: string) => and(eq(edits.projectId, projectId), eq(edits.assetId, assetId));

async function source(access: Access, assetId: string, image = false) {
  const p = await owned(access);
  const asset = p?.timeline.assets.find(item => item.id === assetId);
  if (!p || !asset) return null;
  const { projectId } = access;
  const read = () => db.select({ status: jobs.status, original: jobs.originalWords, imported: edits.imported, reviewed: edits.reviewed,
    revision: edits.revision, timestampsMs: jobs.timestampsMs, data: image ? jobs.sheet : sql<null>`null` }).from(jobs)
    .leftJoin(edits, joined).where(jobKey(projectId, assetId));
  let [row] = await read();
  if (!row) {
    await db.insert(jobs).values({ projectId, assetId, version: analysisVersion }).onConflictDoNothing();
    await enqueueMedia({ kind: "analysis", projectId, assetId });
    [row] = await read();
    if (!row) return null;
  }
  const words = row.reviewed ?? row.imported ?? row.original ?? [];
  const transcriptStatus = row.reviewed ? "corrected" : row.imported ? "imported" : row.original?.length ? "transcribed"
    : row.original ? "no-speech" : row.status === "failed" ? "unavailable" : "pending";
  return { asset, words, row, info: { assetId, assetName: asset.name, status: row.status, hasAudio: asset.metadata?.hasAudio ?? true,
    mediaType: asset.metadata?.mediaType ?? "video", width: asset.metadata?.width, height: asset.metadata?.height,
    durationMs: Math.round(asset.duration * 1000 / p.timeline.fps), timestampsMs: row.timestampsMs ?? [], transcriptStatus, wordCount: words.length } };
}

export async function inspectSource(access: Access, assetId: string) {
  const data = await source(access, assetId, true);
  if (!data) return null;
  return { ...data.info, version: analysisVersion, jpeg: data.row.data ? Buffer.from(data.row.data, "base64") : null };
}

export async function readTranscript(access: Access, assetId: string, offset: number, view: "active" | "original" | "imported") {
  const data = await source(access, assetId);
  if (!data) return null;
  const words = (view === "original" ? data.row.original : view === "imported" ? data.row.imported : data.words) ?? [];
  return { ...data.info, version: analysisVersion, revision: data.row.revision ?? 0, hasOriginal: Boolean(data.row.original?.length),
    hasImport: Boolean(data.row.imported), total: words.length, offset, words: words.slice(offset, offset + 60) };
}

type Update = { revision: number } & ({ subtitles: string } | { index: number; correction: WordCorrection });
export async function updateTranscript(access: Access, assetId: string, update: Update) {
  const data = await source(access, assetId);
  if (!data) throw new MediaError("Source not found.", 404);
  const { projectId } = access;
  await db.transaction(async tx => {
    // Every writer locks the same result, including two simultaneous first imports.
    const [job] = await tx.select({ original: jobs.originalWords }).from(jobs).where(jobKey(projectId, assetId)).for("update");
    const [prior] = await tx.select().from(edits).where(editKey(projectId, assetId));
    if ((prior?.revision ?? 0) !== update.revision) throw new MediaError("Transcript changed. Reload it before saving.", 409);
    let imported = prior?.imported ?? null, reviewed = prior?.reviewed ?? null;
    try {
      if ("subtitles" in update) {
        imported = parseSubtitles(update.subtitles, data.info.durationMs);
        reviewed = null;
      } else {
        reviewed = correctWord(reviewed ?? imported ?? job.original ?? [], update.index, update.correction, data.info.durationMs);
      }
    } catch (error) {
      throw new MediaError(error instanceof z.ZodError ? "Check the word and source times." : error instanceof Error ? error.message : "Invalid transcript.", 422);
    }
    const values = { imported, reviewed, revision: update.revision + 1 };
    await tx.insert(edits).values({ projectId, assetId, ...values }).onConflictDoUpdate({ target: [edits.projectId, edits.assetId], set: values });
  });
}

export async function retryAnalysis(access: Access, assetId: string) {
  if (!await source(access, assetId)) return false;
  await db.update(jobs).set({ status: "queued" }).where(and(jobKey(access.projectId, assetId), eq(jobs.status, "failed")));
  await enqueueMedia({ kind: "analysis", projectId: access.projectId, assetId });
  return true;
}

export type SearchInput = { phrase?: string; startMs?: number; endMs?: number; assetId?: string; clipId?: string; offset?: number };
export async function searchTranscripts(access: Access, input: SearchInput) {
  const p = await owned(access);
  if (!p) return null;
  const assets = p.timeline.assets.filter(a => !input.assetId || a.id === input.assetId);
  const query = input.phrase !== undefined ? { phrase: input.phrase } : { startMs: input.startMs!, endMs: input.endMs! };
  const offset = input.offset ?? 0;
  const matches: (TranscriptMatch & { assetId: string; assetName: string; placements: SourcePlacement[] })[] = [];
  const pendingAssetIds: string[] = [];
  let skipped = 0;
  for (let i = 0; i < assets.length; i += 20) {
    const batch = assets.slice(i, i + 20);
    const rows = await db.select({ assetId: jobs.assetId, status: jobs.status,
      words: sql<typeof jobs.$inferSelect.originalWords>`coalesce(${edits.reviewed}, ${edits.imported}, ${jobs.originalWords})` })
      .from(jobs).leftJoin(edits, joined).where(and(eq(jobs.projectId, access.projectId), eq(jobs.version, analysisVersion), inArray(jobs.assetId, batch.map(a => a.id))));
    const missing = batch.filter(a => !rows.some(row => row.assetId === a.id));
    if (missing.length) {
      await db.insert(jobs).values(missing.map(a => ({ projectId: access.projectId, assetId: a.id, version: analysisVersion }))).onConflictDoNothing();
      await Promise.all(missing.map(a => enqueueMedia({ kind: "analysis", projectId: access.projectId, assetId: a.id })));
    }
    for (const asset of batch) {
      const row = rows.find(r => r.assetId === asset.id);
      if (!row?.words) {
        if (!row || row.status !== "failed") pendingAssetIds.push(asset.id);
        continue;
      }
      for (const hit of lookupTranscript(row.words, query)) {
        if (skipped < offset) { skipped++; continue; }
        if (matches.length === 20) return { revision: p.revision, matches, nextOffset: offset + 20, pendingAssetIds };
        const scope = input.clipId ? { kind: "clip" as const, clipId: input.clipId } : { kind: "all" as const };
        matches.push({ ...hit, assetId: asset.id, assetName: asset.name, placements: mapSourceRange(p.timeline, asset.id, hit, scope) });
      }
    }
  }
  return { revision: p.revision, matches, nextOffset: null, pendingAssetIds };
}
