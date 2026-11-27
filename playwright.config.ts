import { defineConfig } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { apiOrigin, migrationDatabase, testDatabase, webOrigin } from "./tests/local";

const production = process.env.E2E_PRODUCTION === "1";
const liveCodex = process.env.E2E_LIVE_CODEX === "1";
const runnerSecret = randomBytes(32).toString("hex");

export default defineConfig({
  testDir: "./tests",
  workers: 2,
  timeout: 120_000,
  use: {
    baseURL: webOrigin,
    channel: process.env.TEST_BROWSER_CHANNEL,
    viewport: { width: 1440, height: 900 },
  },
  webServer: [
    {
      command: "bun tests/fixtures/responses.ts", url:"http://127.0.0.1:4202/health",
      env:{CUTROOM_FIXTURE_PORT:"4202",OPENAI_API_KEY:""},
    },
    {
      cwd:"apps/runner", command:"bun run start", url:"http://127.0.0.1:4201/health",
      env:{CUTROOM_RUNNER_PORT:"4201",CUTROOM_API_ORIGIN:apiOrigin,CUTROOM_RUNNER_SECRET:runnerSecret,
        CUTROOM_OPENAI_BASE_URL:liveCodex ? "https://api.openai.com/v1" : "http://127.0.0.1:4202/v1",
        OPENAI_API_KEY:liveCodex ? process.env.OPENAI_API_KEY ?? "" : "fixture-only"},
    },
    {
      cwd: "apps/api",
      command: "MIGRATION_DATABASE_URL=" + migrationDatabase + " bun src/db/migrate.ts && bun src/index.ts",
      url: apiOrigin + "/api/auth/ok",
      env: {
        DATABASE_URL: testDatabase, BETTER_AUTH_URL: webOrigin, BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
        CUTROOM_RUNNER_URL:"http://127.0.0.1:4201",CUTROOM_RUNNER_SECRET:runnerSecret,CUTROOM_DAILY_TURNS:"1",OPENAI_API_KEY:"",
        NODE_ENV: production ? "production" : "test", CUTROOM_RENDER_DIR: resolve(".renders/test"),
        CUTROOM_MEDIA_STORAGE: process.env.E2E_LIVE_IMAGEKIT === "1" ? "imagekit" : "local",
        CUTROOM_MEDIA_DIR: resolve(".local/media-test"),
        API_PORT: "4100", SMTP_URL: "smtp://127.0.0.1:1025", MAIL_FROM: "Cutroom <accounts@cutroom.test>",
      },
    },
    {
      cwd: "apps/web", url: webOrigin,
      command: production ? "bun run build && bun run start --port 3100" : "bun run dev --port 3100",
      env: { API_ORIGIN: apiOrigin, NEXT_DIST_DIR: ".next-e2e", OPENAI_API_KEY:"" },
    },
  ],
});
