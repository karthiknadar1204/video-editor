import { runInput, RunnerError } from "./client";
import { executeTurn } from "./codex";
import { equalSecret } from "./provider";

const secret = process.env.CUTROOM_RUNNER_SECRET ?? "";
const apiKey = process.env.OPENAI_API_KEY ?? "";
const mcpUrl = new URL("/api/mcp", process.env.CUTROOM_API_ORIGIN ?? "http://127.0.0.1:4000").href;
const settings = {
  apiKey,
  baseUrl: process.env.CUTROOM_OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  model: process.env.CUTROOM_CODEX_MODEL ?? "gpt-5.5",
};
const active = new Set<string>();
const encoder = new TextEncoder();

Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.CUTROOM_RUNNER_PORT ?? 4200),
  maxRequestBodySize: 128 * 1024,
  idleTimeout: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/health" && req.method === "GET") return Response.json({ ok: true });
    if (path !== "/runs" || req.method !== "POST") return new Response(null, { status: 404 });
    if (secret.length < 32) return new Response(null, { status: 503 });
    if (!equalSecret(req.headers.get("Authorization") ?? "", "Bearer " + secret))
      return new Response(null, { status: 401 });
    if (!apiKey) return Response.json({ code: "missing_credential" }, { status: 503 });
    const input = runInput.safeParse(await req.json().catch(() => null));
    if (!input.success || input.data.mcpUrl !== mcpUrl) return new Response(null, { status: 400 });
    const { runId } = input.data;
    if (active.has(runId)) return new Response(null, { status: 409 });
    if (active.size >= 8) return new Response(null, { status: 429 });
    active.add(runId);
    const cancel = new AbortController(),
      signal = AbortSignal.any([req.signal, cancel.signal]);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (type: string, message: string) => {
          if (!signal.aborted) controller.enqueue(encoder.encode(JSON.stringify({ type, message }) + "\n"));
        };
        try {
          send("activity", "Connecting to the private Codex runner");
          const result = await executeTurn({ ...input.data, signal, onEvent: (m) => send("activity", m) }, settings);
          send("final", result);
        } catch (error) {
          const failure =
            error instanceof RunnerError ? error : new RunnerError(signal.aborted ? "interrupted" : "runtime");
          if (!signal.aborted)
            controller.enqueue(
              encoder.encode(JSON.stringify({ type: "error", code: failure.code, status: failure.status }) + "\n"),
            );
        } finally {
          active.delete(runId);
          if (!cancel.signal.aborted) controller.close();
        }
      },
      cancel() {
        cancel.abort();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
  },
});
