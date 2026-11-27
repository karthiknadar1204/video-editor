import { lt, sql } from "drizzle-orm";
import { db } from "./db/client";
import { agentUsage } from "./db/schema";
import type { EditTransaction } from "./history";

export class AllowanceError extends Error { readonly status = 429; }

export async function takeAllowance(ownerId: string, kind: "turn" | "render", tx: EditTransaction | typeof db = db) {
  const raw = kind === "turn" ? process.env.CUTROOM_DAILY_TURNS : process.env.CUTROOM_DAILY_RENDERS;
  const limit = Number(raw ?? (kind === "turn" ? 30 : 100));
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid daily allowance.");
  const denied = () => new AllowanceError("Daily " + kind + " allowance reached. It resets at midnight UTC.");
  if (!limit) throw denied();
  const day = new Date().toISOString().slice(0,10);
  const rows = await tx.insert(agentUsage).values({ownerId,day,kind,count:1}).onConflictDoUpdate({
    target:[agentUsage.ownerId,agentUsage.day,agentUsage.kind],
    set:{count:sql`${agentUsage.count} + 1`}, setWhere:lt(agentUsage.count,limit),
  }).returning({count:agentUsage.count});
  if (!rows.length) throw denied();
}
