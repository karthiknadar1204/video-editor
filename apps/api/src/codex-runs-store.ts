import { type RunView, type RunActivity } from "@editor/timeline";
import { and, eq, sql } from "drizzle-orm";
import { db } from "./db/client";
import { codexRun } from "./db/schema";
import type { EditReceipt, EditTransaction } from "./history";

export const publicRunFields = {
  id:codexRun.id, prompt:codexRun.prompt, context:codexRun.context, status:codexRun.status,
  events:codexRun.events, receipt:codexRun.receipt, result:codexRun.result, createdAt:codexRun.createdAt,
};

function append(text: string) {
  const event: RunActivity = {time:new Date().toISOString(), text:text.slice(0,500)};
  return sql`${codexRun.events} || ${JSON.stringify([event])}::jsonb`;
}

export async function addActivity(id: string, text: string) {
  await db.update(codexRun).set({events:append(text)}).where(and(eq(codexRun.id,id), eq(codexRun.status,"running"),
    sql`jsonb_array_length(${codexRun.events}) < 100`));
}
export function recordTool(id:string, tool:string, detail:string) {
  return addActivity(id, tool + " · " + detail);
}
export async function recordEdit(tx:EditTransaction, id:string, receipt:EditReceipt) {
  await tx.update(codexRun).set({receipt, events:append("Title saved · revision " + receipt.revision)}).where(eq(codexRun.id,id));
}
export async function finishRun(id:string, status:Exclude<RunView["status"],"running">, result:string) {
  await db.update(codexRun).set({status,result:result.slice(0,8000)}).where(and(eq(codexRun.id,id),eq(codexRun.status,"running")));
}
