import { executeTurn } from "../../apps/runner/src/codex";

async function main() {
  const input = (await Bun.stdin.json()) as { mcpUrl: string; token: string; prompt: string };
  const live = process.env.E2E_LIVE_CODEX === "1";
  let receivedFrame = false;
  const reply = await executeTurn(
    {
      ...input,
      projectId: crypto.randomUUID(),
      ownerId: "external",
      runId: crypto.randomUUID(),
      context: { external: true },
      signal: AbortSignal.timeout(180_000),
      onEvent: (event) => { if (event === "Model received the rendered frame") receivedFrame = true; },
    },
    {
      model: process.env.CUTROOM_CODEX_MODEL ?? "gpt-5.5",
      baseUrl: live ? "https://api.openai.com/v1" : (process.env.CUTROOM_OPENAI_BASE_URL ?? "http://127.0.0.1:4202/v1"),
      apiKey: live ? (process.env.OPENAI_API_KEY ?? "") : "fixture-only",
    },
  );
  if (!receivedFrame) throw new Error("The external model did not receive the rendered frame.");
  process.stdout.write(reply);
}
void main().catch(() => {
  process.stderr.write("The external Codex turn failed.\n");
  process.exitCode = 1;
});
