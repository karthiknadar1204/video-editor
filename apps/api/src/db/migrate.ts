import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error("Set MIGRATION_DATABASE_URL to the direct database owner connection.");
const client = postgres(url, { max: 1 });
try {
  await migrate(drizzle(client), { migrationsFolder: fileURLToPath(new URL("../../migrations", import.meta.url)) });
} finally {
  await client.end();
}
