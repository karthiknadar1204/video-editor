import { defineConfig } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { apiOrigin, migrationDatabase, testDatabase, webOrigin } from "./tests/local";

const production = process.env.E2E_PRODUCTION === "1";

export default defineConfig({
  testDir: "./tests",
  timeout: 120_000,
  use: {
    baseURL: webOrigin,
    channel: process.env.TEST_BROWSER_CHANNEL,
    viewport: { width: 1440, height: 900 },
  },
  webServer: [
    {
      cwd: "apps/api",
      command: "MIGRATION_DATABASE_URL=" + migrationDatabase + " bun src/db/migrate.ts && bun src/index.ts",
      url: apiOrigin + "/api/auth/ok",
      env: {
        DATABASE_URL: testDatabase, BETTER_AUTH_URL: webOrigin, BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
        NODE_ENV: production ? "production" : "test", CUTROOM_RENDER_DIR: resolve(".renders/test"),
        API_PORT: "4100", SMTP_URL: "smtp://127.0.0.1:1025", MAIL_FROM: "Cutroom <accounts@cutroom.test>",
      },
    },
    {
      cwd: "apps/web", url: webOrigin,
      command: production ? "bun run build && bun run start --port 3100" : "bun run dev --port 3100",
      env: { API_ORIGIN: apiOrigin, NEXT_DIST_DIR: ".next-e2e" },
    },
  ],
});
