export const webOrigin = "http://127.0.0.1:3100";
export const apiOrigin = "http://127.0.0.1:4100";
export const mailbox = "http://127.0.0.1:8025";
const restored = process.env.E2E_RESTORE_DB;
if (restored && !/^cutroom_restore_[0-9]+$/.test(restored)) throw new Error("Choose an isolated local restore database.");
const staging = process.env.E2E_RELEASE_TARGET === "staging";
if (staging && (!process.env.E2E_STAGING_DATABASE_URL || !process.env.E2E_STAGING_MIGRATION_URL || restored)) {
  throw new Error("Provide the isolated staging runtime and migration connections.");
}
export const testDatabase = staging ? process.env.E2E_STAGING_DATABASE_URL! : restored
  ? "postgresql://cutroom_app:local-app@127.0.0.1:55432/" + restored : "postgresql://cutroom_test_app:local-test-app@127.0.0.1:55432/cutroom_test";
export const migrationDatabase = staging ? process.env.E2E_STAGING_MIGRATION_URL! : restored
  ? "postgresql://cutroom_owner:local-owner@127.0.0.1:55432/" + restored : "postgresql://cutroom_test_owner:local-test-owner@127.0.0.1:55432/cutroom_test";
