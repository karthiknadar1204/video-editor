import type { Timeline } from "@editor/timeline";
import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

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
