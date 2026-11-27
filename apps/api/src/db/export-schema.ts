import type { Timeline } from "@editor/timeline";
import { index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { project, projectAsset } from "./schema";

export const exportStates = ["queued", "rendering", "uploading", "completed", "failed", "cancelled"] as const;
export type ExportManifest = {
  composition: string;
  fonts: Record<string, string>;
  sources: { id: string; version: string }[];
  settings: { codec: "h264"; audio: "aac"; pixels: "yuv420p"; width: number; height: number; fps: number };
};
const time = (name: string) => timestamp(name, { withTimezone: true });
export const exportVersion = pgTable("export_version", {
  id: uuid().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => project.id, { onDelete: "restrict" }),
  revision: integer().notNull(),
  title: text().notNull(),
  release: text().notNull(),
  manifest: jsonb().$type<ExportManifest>().notNull(),
  timeline: jsonb().$type<Timeline>().notNull(),
  storage: text({ enum: ["local", "imagekit"] }).notNull(),
  attempt: integer().notNull().default(1),
  watchToken: uuid("watch_token").unique(),
  createdAt: time("created_at").defaultNow().notNull(),
  expiresAt: time("expires_at").notNull(),
}, t => [unique().on(t.projectId, t.revision, t.release), index().on(t.expiresAt)]);

export const exportAttempt = pgTable("export_attempt", {
  exportId: uuid("export_id").notNull().references(() => exportVersion.id, { onDelete: "cascade" }),
  number: integer().notNull(),
  status: text({ enum: exportStates }).notNull().default("queued"),
  progress: integer().notNull().default(0),
  claim: uuid(),
  leaseUntil: time("lease_until"),
  error: text(),
  remoteId: text("remote_id"),
  createdAt: time("created_at").defaultNow().notNull(),
  endedAt: time("ended_at"),
}, t => [primaryKey({ columns: [t.exportId, t.number] }), index().on(t.status, t.leaseUntil, t.createdAt)]);

export const exportSource = pgTable("export_source", {
  exportId: uuid("export_id").notNull().references(() => exportVersion.id, { onDelete: "cascade" }),
  assetId: uuid("asset_id").notNull().references(() => projectAsset.id, { onDelete: "restrict" }),
}, t => [primaryKey({ columns: [t.exportId, t.assetId] })]);
