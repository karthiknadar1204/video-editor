import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 120_000,
  use: {
    baseURL: "http://127.0.0.1:3000",
    channel: process.env.TEST_BROWSER_CHANNEL,
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: "bun run dev",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
  },
});
