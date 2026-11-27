import { defineConfig } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { apiOrigin, migrationDatabase, requireTestServices, testDatabase, testPrefix, testRedis, webOrigin } from "./tests/local";

const production = process.env.E2E_PRODUCTION === "1";
const liveCodex = process.env.E2E_LIVE_CODEX === "1";
const liveMedia = process.env.E2E_LIVE_IMAGEKIT === "1";
const runnerSecret = randomBytes(32).toString("hex");

if (!process.argv.includes("--list")) requireTestServices();

const noCredentials = {
  DATABASE_URL: "", MIGRATION_DATABASE_URL: "", E2E_DATABASE_URL: "", E2E_MIGRATION_DATABASE_URL: "",
  E2E_STAGING_DATABASE_URL: "", E2E_STAGING_MIGRATION_URL: "",
  REDIS_URL: "", E2E_REDIS_URL: "", NEON_API_KEY: "", OPENAI_API_KEY: "", CUTROOM_RUNNER_SECRET: "",
  IMAGEKIT_URL_ENDPOINT: "", IMAGEKIT_PUBLIC_KEY: "", IMAGEKIT_PRIVATE_KEY: "", BETTER_AUTH_SECRET: "",
};
const mediaEnv = {
  ...noCredentials,
  DATABASE_URL: testDatabase, REDIS_URL: testRedis, REDIS_PREFIX: testPrefix,
  CUTROOM_RENDER_DIR: resolve(".renders/test"), CUTROOM_MEDIA_DIR: resolve(".local/media-test"),
  CUTROOM_MEDIA_STORAGE: liveMedia ? "imagekit" : "local",
  ...(liveMedia && {
    IMAGEKIT_URL_ENDPOINT: process.env.IMAGEKIT_URL_ENDPOINT ?? "",
    IMAGEKIT_PUBLIC_KEY: process.env.IMAGEKIT_PUBLIC_KEY ?? "",
    IMAGEKIT_PRIVATE_KEY: process.env.IMAGEKIT_PRIVATE_KEY ?? "",
  }),
};

export default defineConfig({
  testDir: "./tests",
  workers: 2,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: webOrigin,
    trace: liveCodex || liveMedia || process.env.E2E_RELEASE_TARGET ? "off" : "retain-on-failure",
    channel: process.env.TEST_BROWSER_CHANNEL,
    viewport: { width: 1440, height: 900 },
  },
  webServer: [
    {
      command: "bun --no-env-file tests/fixtures/responses.ts",
      url: "http://127.0.0.1:4202/health",
      env: { ...noCredentials, CUTROOM_FIXTURE_PORT: "4202" },
    },
    {
      cwd: "apps/runner", command: "bun --no-env-file src/index.ts", url: "http://127.0.0.1:4201/health",
      env: {
        ...noCredentials, CUTROOM_RUNNER_PORT: "4201", CUTROOM_API_ORIGIN: apiOrigin, CUTROOM_RUNNER_SECRET: runnerSecret,
        CUTROOM_OPENAI_BASE_URL: liveCodex ? "https://api.openai.com/v1" : "http://127.0.0.1:4202/v1",
        OPENAI_API_KEY: liveCodex ? process.env.OPENAI_API_KEY ?? "" : "fixture-only",
      },
    },
    {
      cwd: "apps/api",
      command: "bun --no-env-file src/db/migrate.ts && exec env -u MIGRATION_DATABASE_URL bun --no-env-file src/worker.ts",
      wait: { stdout: /Cutroom worker ready/ }, timeout: 180_000,
      env: { ...mediaEnv, MIGRATION_DATABASE_URL: migrationDatabase },
    },
    {
      cwd: "apps/api", command: "bun --no-env-file src/index.ts", url: apiOrigin + "/api/auth/ok",
      env: {
        ...mediaEnv, NODE_ENV: production ? "production" : "test", API_PORT: "4100",
        BETTER_AUTH_URL: webOrigin, BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
        SMTP_URL: "smtp://127.0.0.1:1025", MAIL_FROM: "Cutroom <accounts@cutroom.test>",
        CUTROOM_RUNNER_URL: "http://127.0.0.1:4201", CUTROOM_RUNNER_SECRET: runnerSecret, CUTROOM_DAILY_TURNS: "1",
      },
    },
    {
      cwd: "apps/web", url: webOrigin, timeout: 180_000,
      command: production ? "bun --no-env-file run build && bun --no-env-file run start --port 3100" : "bun --no-env-file run dev --port 3100",
      env: { ...noCredentials, API_ORIGIN: apiOrigin, NEXT_DIST_DIR: ".next-e2e" },
    },
  ],
});
