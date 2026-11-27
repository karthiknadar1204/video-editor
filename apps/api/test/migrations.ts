import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { readTimeline } from "@editor/timeline";

// This test owns its scratch database on the local Compose cluster.
const local = new URL("postgresql://cutroom_owner:local-owner@127.0.0.1:55432/postgres");
const admin = postgres(local.href, { max: 1 });
const name = "cutroom_upgrade_" + crypto.randomUUID().replaceAll("-", "");
const folder = fileURLToPath(new URL("../migrations", import.meta.url));
const previous = await mkdtemp(join(tmpdir(), "cutroom-upgrade-"));
try {
  await admin`CREATE DATABASE ${admin(name)}`;
  local.pathname = "/" + name;
  const sql = postgres(local.href, { max: 1 });
  try {
    const journal = JSON.parse(await readFile(join(folder, "meta/_journal.json"), "utf8"));
    const first = journal.entries[0];
    await mkdir(join(previous, "meta"));
    await writeFile(join(previous, "meta/_journal.json"), JSON.stringify({ ...journal, entries: [first] }));
    await copyFile(join(folder, first.tag + ".sql"), join(previous, first.tag + ".sql"));
    const db = drizzle(sql);
    await migrate(db, { migrationsFolder: previous });
    const id = crypto.randomUUID();
    const timeline = { id, name: "First draft", width: 1280, height: 720, fps: 30, durationInFrames: 150,
      videoTrack: [{ id: "old-clip", src: "media/earthrise.mp4", sourceStart: 12, start: 30, duration: 120 }],
      title: { text: "Original title", start: 60, duration: 30 } };
    await sql`INSERT INTO "user" (id, name, email) VALUES ('owner', 'Fixture', 'fixture@cutroom.test')`;
    await sql`INSERT INTO project (id, owner_id, title, timeline) VALUES (${id}, 'owner', 'First draft', ${JSON.stringify(timeline)}::jsonb)`;
    await migrate(db, { migrationsFolder: folder });
    const [saved] = await sql`SELECT owner_id, title, timeline, format_version, revision FROM project WHERE id = ${id}`;
    assert.deepEqual({ ...saved }, { owner_id: "owner", title: "First draft", timeline, format_version: 1, revision: 0 });
    const upgraded = readTimeline(saved.format_version, saved.timeline);
    assert.equal(upgraded.clips[0].id, "old-clip");
    assert.equal(upgraded.clips[0].kind === "media" && upgraded.clips[0].sourceStart, 12);
    assert.equal(upgraded.clips[1].kind === "text" && upgraded.clips[1].text, "Original title");
  } finally {
    await sql.end();
    await admin`DROP DATABASE ${admin(name)}`;
  }
} finally {
  await admin.end();
  await rm(previous, { recursive: true, force: true });
}
