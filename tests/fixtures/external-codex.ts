import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";

// Playwright runs in Node. Start the external Bun client independently and pass its project credential on stdin.
export function runExternalCodex(input: {
  mcpUrl: string;
  token: string;
  prompt: string;
  minCandidateImages?: number;
}): Promise<string> {
  const live = process.env.E2E_LIVE_CODEX === "1";
  const measure = live && process.env.E2E_RELEASE_METRICS === "1";
  const env = {
    PATH: process.env.PATH,
    E2E_LIVE_CODEX: live ? "1" : "0",
    E2E_RELEASE_METRICS: measure ? "1" : "0",
    CUTROOM_CODEX_MODEL: process.env.CUTROOM_CODEX_MODEL,
    CUTROOM_OPENAI_BASE_URL: process.env.CUTROOM_OPENAI_BASE_URL,
    OPENAI_API_KEY: live ? process.env.OPENAI_API_KEY : undefined,
  };
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [join(process.cwd(), "tests", "fixtures", "external-turn.ts")], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 190_000,
    });
    let text = "";
    createInterface({ input: child.stderr }).on("line", (line) => {
      if (measure && /^CUTROOM_MODEL_USAGE(?: \d+){5}$/.test(line)) console.info("External", line);
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      text += chunk;
    });
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(text) : reject(new Error("The external Codex turn failed."))));
    child.stdin.end(JSON.stringify(input));
  });
}
