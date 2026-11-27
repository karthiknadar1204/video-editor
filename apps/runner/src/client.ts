import { z } from "zod";

export const runInput = z.strictObject({
  projectId: z.uuid(),
  ownerId: z.string().min(1).max(256),
  runId: z.uuid(),
  prompt: z.string().trim().min(1).max(8000),
  context: z.unknown(),
  mcpUrl: z.url(),
  token: z.string().min(1).max(2048),
});
export type RunInput = z.infer<typeof runInput>;
export type RunOptions = RunInput & { signal: AbortSignal; onEvent: (message: string) => void | Promise<void> };
const reasons = {
  missing_credential: "Configure the private runner's OpenAI API key.",
  credential: "The model credential was rejected.",
  credits: "The OpenAI API project has no available credits. Check its billing or usage limit.",
  rate_limit: "The model service rate limit was reached. Try again shortly.",
  upstream: "The model service could not complete the request.",
  contract: "The runner could not verify the model response or the editor tool contract.",
  deadline: "The model request exceeded its time limit.",
  interrupted: "The Codex turn was interrupted.",
  unavailable: "The private Codex runner is unavailable.",
  capacity: "The private Codex runner is busy. Try again shortly.",
  connection: "The Codex connection closed before the turn finished.",
  runtime: "The pinned Codex app-server could not finish the turn.",
} as const;
const reason = z.enum(Object.keys(reasons) as [keyof typeof reasons, ...(keyof typeof reasons)[]]);
const remoteError = z.object({ code: reason, status: z.int().min(400).max(599).optional() });
export class RunnerError extends Error {
  constructor(
    readonly code: keyof typeof reasons,
    readonly status?: number,
  ) {
    super(
      code === "upstream" && status ? "The model service rejected the request (HTTP " + status + ")." : reasons[code],
    );
    this.name = "RunnerError";
  }
}
const record = z.discriminatedUnion("type", [
  z.object({ type: z.literal("activity"), message: z.string() }),
  z.object({ type: z.literal("final"), message: z.string() }),
  remoteError.extend({ type: z.literal("error") }),
]);

export async function runCodex({ signal, onEvent, ...input }: RunOptions): Promise<string> {
  const url = process.env.CUTROOM_RUNNER_URL ?? "http://127.0.0.1:4200";
  const secret = process.env.CUTROOM_RUNNER_SECRET;
  if (!secret) throw new RunnerError("unavailable");
  const response = await fetch(url + "/runs", {
    method: "POST",
    signal,
    redirect: "error",
    headers: { Authorization: "Bearer " + secret, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).catch(() => {
    throw new RunnerError(signal.aborted ? "interrupted" : "unavailable");
  });
  if (!response.ok || !response.body) {
    const err = remoteError.safeParse(await response.json().catch(() => null));
    if (err.success) throw new RunnerError(err.data.code, err.data.status);
    throw new RunnerError(response.status === 429 ? "capacity" : "unavailable");
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new RunnerError("connection");
      const lines = (pending + value).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const item = record.parse(JSON.parse(line));
        if (item.type === "error") throw new RunnerError(item.code, item.status);
        if (item.type === "final") return item.message;
        await onEvent(item.message);
      }
    }
  } catch (error) {
    if (error instanceof RunnerError) throw error;
    throw new RunnerError(signal.aborted ? "interrupted" : "connection");
  } finally {
    await reader.cancel().catch(() => {});
  }
}
