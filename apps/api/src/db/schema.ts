import type { Change, EditorContext, EditRequest, Patch, RoughCutOptions, RoughCutReceipt, RunActivity, RunView, Timeline, TranscriptWord } from "@editor/timeline";
import { bigint, boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

const time = (name: string) => timestamp(name, { withTimezone: true });
const timestamps = () => ({
  createdAt: time("created_at").defaultNow().notNull(),
  updatedAt: time("updated_at").defaultNow().notNull(),
});

export const user = pgTable("user", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().unique().notNull(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text(),
  ...timestamps(),
});

export const account = pgTable("account", {
  id: text().primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  password: text(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: time("access_token_expires_at"),
  refreshTokenExpiresAt: time("refresh_token_expires_at"),
  scope: text(),
  ...timestamps(),
}, t => [index().on(t.userId), unique().on(t.providerId, t.accountId)]);

export const session = pgTable("session", {
  id: text().primaryKey(),
  token: text().unique().notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  expiresAt: time("expires_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  ...timestamps(),
}, t => [index().on(t.userId)]);

export const verification = pgTable("verification", {
  id: text().primaryKey(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: time("expires_at").notNull(),
  ...timestamps(),
}, t => [index().on(t.identifier)]);

export const rateLimit = pgTable("rate_limit", {
  id: text().primaryKey(),
  key: text().unique().notNull(),
  count: integer().notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

export const project = pgTable("project", {
  id: uuid().primaryKey(),
  ownerId: text("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  title: text().notNull(),
  timeline: jsonb().$type<Timeline>().notNull(),
  formatVersion: integer("format_version").notNull().default(1),
  revision: integer().notNull().default(0),
  ...timestamps(),
}, t => [index().on(t.ownerId, t.updatedAt, t.id)]);

export const projectEdit = pgTable("project_edit", {
  projectId: uuid("project_id").notNull().references(() => project.id, { onDelete: "cascade" }),
  revision: integer().notNull(),
  actorId: text("actor_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  requestId: uuid("request_id").notNull(),
  command: jsonb().$type<EditRequest>().notNull(),
  forward: jsonb().$type<Patch>().notNull(),
  inverse: jsonb().$type<Patch>().notNull(),
  affected: jsonb().$type<{ from: number; to: number }>(),
  state: text({ enum: ["applied", "undone", "abandoned"] }),
  targetRevision: integer("target_revision"),
  createdAt: time("created_at").defaultNow().notNull(),
}, t => [primaryKey({ columns: [t.projectId, t.revision] }), unique().on(t.projectId, t.requestId),
  index().on(t.projectId, t.state, t.revision)]);

export const projectAsset = pgTable("project_asset", {
  id: uuid().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => project.id, { onDelete: "cascade" }),
  name: text().notNull(),
  mime: text().notNull(),
  size: integer().notNull(),
  storage: text({ enum: ["local", "imagekit"] }).notNull(),
  state: text({ enum: ["pending", "processing", "ready", "cancelled"] }).notNull(),
  asset: jsonb().$type<Timeline["assets"][number]>(),
  expiresAt: time("expires_at").notNull(),
}, t => [index().on(t.projectId), index().on(t.state, t.expiresAt)]);

export const codexConnection = pgTable("codex_connection", {
  projectId: uuid("project_id").primaryKey().references(() => project.id, {onDelete:"cascade"}),
  secretHash: text("secret_hash").unique().notNull(),
  expiresAt: time("expires_at").notNull(), lastUsedAt: time("last_used_at"),
});

export const codexRun = pgTable("codex_run", {
  id: uuid().primaryKey(),
  projectId: uuid("project_id").notNull().references(() => project.id, {onDelete:"cascade"}),
  ownerId: text("owner_id").notNull().references(() => user.id, {onDelete:"cascade"}),
  tabId: uuid("tab_id").notNull(), context: jsonb().$type<EditorContext>().notNull(),
  prompt: text().notNull(), status: text({enum:["running","completed","stopped","failed"]}).notNull(),
  tokenHash: text("token_hash").unique().notNull(), expiresAt: time("expires_at").notNull(),
  lastReadRevision: integer("last_read_revision"),
  events: jsonb().$type<RunActivity[]>().notNull().default([]),
  result: text(), receipt: jsonb().$type<NonNullable<RunView["receipt"]>>(),
  createdAt: time("created_at").defaultNow().notNull(),
}, t => [index().on(t.projectId,t.tabId,t.createdAt)]);

export const agentUsage = pgTable("agent_usage", {
  ownerId:text("owner_id").notNull().references(() => user.id, {onDelete:"cascade"}),
  day:text().notNull(), kind:text({enum:["turn","render"]}).notNull(), count:integer().notNull(),
}, t => [primaryKey({columns:[t.ownerId,t.day,t.kind]})]);

export const frameJob = pgTable("frame_job", {
  id:uuid().primaryKey(), projectId:uuid("project_id").notNull().references(() => project.id, {onDelete:"cascade"}),
  revision:integer().notNull(), frame:integer().notNull(), fps:integer().notNull(),
  timeline:jsonb().$type<Timeline>(), status:text({enum:["queued","running","ready","failed"]}).notNull().default("queued"),
  data:text(), error:text(), ...timestamps(),
}, t => [unique().on(t.projectId,t.revision,t.frame), index().on(t.status,t.createdAt)]);

export const sourceAnalysis = pgTable("source_analysis", {
  projectId: uuid("project_id").notNull().references(() => project.id, { onDelete: "cascade" }),
  assetId: text("asset_id").notNull(),
  version: text().notNull(),
  status: text({ enum: ["queued", "processing", "ready", "failed"] }).notNull().default("queued"),
  leaseId: uuid("lease_id"),
  leaseUntil: time("lease_until"),
  originalWords: jsonb("original_words").$type<TranscriptWord[]>(),
  sheet: text(),
  timestampsMs: jsonb("timestamps_ms").$type<number[]>(),
  createdAt: time("created_at").defaultNow().notNull(),
}, t => [primaryKey({ columns: [t.projectId, t.assetId, t.version] }), index().on(t.version, t.status, t.createdAt)]);

export const sourceTranscript = pgTable("source_transcript", {
  projectId: uuid("project_id").notNull().references(() => project.id, { onDelete: "cascade" }),
  assetId: text("asset_id").notNull(),
  revision: integer().notNull(),
  imported: jsonb().$type<TranscriptWord[]>(),
  reviewed: jsonb().$type<TranscriptWord[]>(),
}, t => [primaryKey({ columns: [t.projectId, t.assetId] })]);

export { exportVersion, exportAttempt, exportSource } from "./export-schema";

export const roughCutReview = pgTable("rough_cut_review", {
  projectId: uuid("project_id").notNull().references(() => project.id, { onDelete: "cascade" }),
  id: uuid().notNull(),
  runId: uuid("run_id").references(() => codexRun.id, { onDelete: "cascade" }),
  options: jsonb().$type<RoughCutOptions>().notNull(),
  baseRevision: integer("base_revision").notNull(),
  before: jsonb().$type<Timeline>().notNull(),
  operations: jsonb().$type<Change[]>().notNull(),
  receipt: jsonb().$type<RoughCutReceipt>().notNull(),
  committedRevision: integer("committed_revision"),
  previewImage: jsonb("preview_image").$type<{ frame: number; data: string }>(),
  createdAt: time("created_at").defaultNow().notNull(),
}, t => [primaryKey({ columns: [t.projectId, t.id] }), index().on(t.projectId, t.createdAt)]);
