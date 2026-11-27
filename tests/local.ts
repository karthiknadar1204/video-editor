export const webOrigin = "http://127.0.0.1:3100";
export const apiOrigin = "http://127.0.0.1:4100";
export const mailbox = "http://127.0.0.1:8025";
export const testDatabase = process.env.E2E_DATABASE_URL ?? "";
export const migrationDatabase = process.env.E2E_MIGRATION_DATABASE_URL ?? "";
export const testRedis = process.env.E2E_REDIS_URL ?? "redis://127.0.0.1:6379";
const database = testDatabase ? new URL(testDatabase) : undefined;
export const testPrefix = process.env.E2E_REDIS_PREFIX ?? (database
  ? "cutroom-e2e-" + database.hostname.split(".")[0].replace(/-pooler$/, "") + "-" + database.pathname.slice(1)
  : "cutroom-e2e");

export function requireTestServices() {
  if (!testDatabase || !migrationDatabase) throw new Error("Set E2E_DATABASE_URL and E2E_MIGRATION_DATABASE_URL in .env.e2e.local for the isolated Neon test branch.");
  const runtime = new URL(testDatabase), direct = new URL(migrationDatabase);
  if (runtime.pathname !== direct.pathname || runtime.hostname.replace("-pooler.", ".") !== direct.hostname ||
    direct.hostname.includes("-pooler.") || runtime.username === direct.username) {
    throw new Error("Use a runtime role and separate direct migration role on the same Neon test database.");
  }
}
