import { isDeepStrictEqual } from "node:util";
import { applyPatch, editLabel, editTimeline, readTimeline, type EditRequest } from "@editor/timeline";
import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import { db } from "./db/client";
import { project, projectEdit } from "./db/schema";

const owned = (id: string, owner: string) => and(eq(project.id, id), eq(project.ownerId, owner));
const hasEntry = (state: "applied" | "undone") => sql<boolean>`exists(select 1 from ${projectEdit}
  where ${projectEdit.projectId} = ${project.id} and ${projectEdit.state} = ${state})`;

export async function getProject(id: string, owner: string) {
  const [row] = await db.select({
    id: project.id, title: project.title, timeline: project.timeline, formatVersion: project.formatVersion,
    revision: project.revision, canUndo: hasEntry("applied"), canRedo: hasEntry("undone"),
  }).from(project).where(owned(id, owner));
  if (!row) return;
  const entries = await db.select({ revision: projectEdit.revision, command: projectEdit.command, affected: projectEdit.affected })
    .from(projectEdit).where(and(eq(projectEdit.projectId, id), lte(projectEdit.revision, row.revision)))
    .orderBy(desc(projectEdit.revision)).limit(12);
  const history = entries.map(e => ({ revision: e.revision, label: editLabel(e.command), from: e.affected?.from ?? null }));
  return { ...row, formatVersion: 2, timeline: readTimeline(row.formatVersion, row.timeline), history };
}

export class HistoryError extends Error {
  constructor(readonly status: 404 | 409 | 422, message: string, readonly revision?: number) { super(message); }
}

export async function saveEdit(id: string, owner: string, command: EditRequest) {
  return db.transaction(async tx => {
    const [row] = await tx.select().from(project).where(owned(id, owner)).for("update");
    if (!row) throw new HistoryError(404, "Project not found.");
    const within = eq(projectEdit.projectId, id);
    const [prior] = await tx.select({ command: projectEdit.command, revision: projectEdit.revision, affected: projectEdit.affected })
      .from(projectEdit).where(and(within, eq(projectEdit.requestId, command.requestId)));
    if (prior) {
      if (!isDeepStrictEqual(prior.command, command)) throw new HistoryError(409, "Request ID already used for a different edit.", row.revision);
      return { requestId: command.requestId, revision: prior.revision, affected: prior.affected };
    }
    if (row.revision !== command.expectedRevision) throw new HistoryError(409, "The timeline changed. Load the latest revision.", row.revision);
    const current = readTimeline(row.formatVersion, row.timeline);
    const revision = row.revision + 1;
    let change;
    let targetRevision: number | null = null;
    if (command.kind === "edit") {
      change = editTimeline(current, command.operations);
      await tx.update(projectEdit).set({ state: "abandoned" }).where(and(within, eq(projectEdit.state, "undone")));
    } else {
      const undo = command.kind === "undo";
      const [target] = await tx.select().from(projectEdit).where(and(within, eq(projectEdit.state, undo ? "applied" : "undone")))
        .orderBy(undo ? desc(projectEdit.revision) : asc(projectEdit.revision)).limit(1);
      if (!target) throw new HistoryError(422, "Nothing to " + command.kind + ".");
      const forward = undo ? target.inverse : target.forward;
      change = { timeline: applyPatch(current, forward), forward, inverse: undo ? target.forward : target.inverse, affected: target.affected };
      targetRevision = target.revision;
      await tx.update(projectEdit).set({ state: undo ? "undone" : "applied" }).where(and(within, eq(projectEdit.revision, targetRevision)));
    }
    await tx.update(project).set({ revision, formatVersion: 2, timeline: change.timeline, updatedAt: new Date() }).where(owned(id, owner));
    await tx.insert(projectEdit).values({ projectId: id, revision, actorId: owner, command, requestId: command.requestId,
      forward: change.forward, inverse: change.inverse, affected: change.affected, targetRevision, state: command.kind === "edit" ? "applied" : null });
    return { requestId: command.requestId, revision, affected: change.affected };
  });
}
