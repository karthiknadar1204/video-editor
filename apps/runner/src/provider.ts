import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { RunnerError } from "./client";

export const toolNames = [
  "read_project",
  "list_assets",
  "inspect_selection",
  "update_title",
  "render_frame",
  "search_transcript",
  "inspect_source",
  "rough_cut",
  "start_export",
  "export_status",
] as const;
const toolName = z.enum(toolNames);
const namespace = "mcp__cutroom";
const declaration = z.object({
  type: z.literal("function"),
  name: toolName,
  description: z.string(),
  parameters: z.object({}).passthrough(),
  strict: z.boolean().optional(),
});
const toolset = z.object({
  type: z.literal("namespace"),
  name: z.literal(namespace),
  description: z.string(),
  tools: z.array(declaration).length(toolNames.length),
});
const responseId = z.string().min(1).max(256);
const assistantItem = z.object({
  type: z.literal("message"),
  id: responseId,
  role: z.literal("assistant"),
  phase: z.enum(["commentary", "final_answer"]).optional().nullable(),
  content: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("output_text"), text: z.string() }),
      z.object({ type: z.literal("refusal"), refusal: z.string() }),
    ]),
  ),
});
const reasoningItem = z.object({
  type: z.literal("reasoning"),
  id: responseId,
  encrypted_content: z.string().nullable().optional(),
  summary: z.array(z.object({ type: z.literal("summary_text"), text: z.string() })).optional(),
  content: z
    .array(z.object({ type: z.literal("reasoning_text"), text: z.string() }))
    .nullable()
    .optional(),
});
const callItem = z.object({
  type: z.literal("function_call"),
  id: responseId.optional(),
  call_id: responseId,
  namespace: z.literal(namespace),
  name: toolName,
  arguments: z.string().max(64000),
});
const count = z.number().int().nonnegative();
const usage = z.object({ input_tokens: z.number(), output_tokens: z.number(), total_tokens: z.number() });
const measuredReply = z.object({ usage: z.object({
  input_tokens: count, output_tokens: count, total_tokens: count,
  input_tokens_details: z.object({ cached_tokens: count }).nullish(),
  output_tokens_details: z.object({ reasoning_tokens: count }).nullish(),
}) });
const modelReply = z.object({
  id: responseId,
  status: z.literal("completed"),
  output: z.array(z.discriminatedUnion("type", [assistantItem, reasoningItem, callItem])),
  usage: usage.nullish(),
});

async function serviceError(response: Response) {
  if (response.status === 401 || response.status === 403) return new RunnerError("credential", response.status);
  if (response.status === 429) {
    const body = z
      .object({ error: z.object({ code: z.string().nullish(), type: z.string().nullish() }) })
      .safeParse(await response.json().catch(() => null));
    const exhausted =
      body.success &&
      [body.data.error.code, body.data.error.type].some(
        (code) => code === "credit_balance_exhausted" || code === "insufficient_quota",
      );
    return new RunnerError(exhausted ? "credits" : "rate_limit", 429);
  }
  return new RunnerError("upstream", response.status);
}

export function equalSecret(actual: string, expected: string) {
  const a = Buffer.from(actual),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const event = (type: string, data: object) =>
  "event: " + type + "\ndata: " + JSON.stringify({ type, ...data }) + "\n\n";

// The CLI also declares general computer tools. The provider accepts exactly one native MCP namespace,
// and validates the complete upstream response before emitting any callable item back to the CLI.
const nativeImage = z.object({ type: z.literal("input_image"), image_url: z.string().startsWith("data:image/") });
const imageTool = z.enum(["render_frame", "inspect_source", "rough_cut"]);
const imageCall = z.object({
  type: z.literal("function_call"),
  namespace: z.literal(namespace),
  name: imageTool,
  call_id: responseId,
});
const toolOutput = z.object({
  type: z.literal("function_call_output"),
  call_id: responseId,
  output: z.array(z.unknown()),
});
type ImageTool = z.infer<typeof imageTool>;

function imageReceipts(input: unknown[]) {
  const tools = new Map<string, ImageTool>();
  const received = new Map<string, ImageTool>();
  for (const item of input) {
    const call = imageCall.safeParse(item);
    if (call.success) {
      tools.set(call.data.call_id, call.data.name);
      continue;
    }
    const result = toolOutput.safeParse(item);
    if (!result.success) continue;
    const tool = tools.get(result.data.call_id);
    if (tool && result.data.output.some((part) => nativeImage.safeParse(part).success))
      received.set(result.data.call_id, tool);
  }
  return received;
}

export function openProvider(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  signal: AbortSignal;
  onImageReceived: (tool: ImageTool) => void | Promise<void>;
}) {
  const base = new URL(options.baseUrl);
  if (!(base.origin === "https://api.openai.com" || (base.hostname === "127.0.0.1" && base.protocol === "http:"))) {
    throw new Error("Configure the OpenAI API or the loopback test model.");
  }
  const key = crypto.randomUUID();
  let failure: RunnerError | undefined;
  const acknowledged = new Set<string>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      if (
        req.method !== "POST" ||
        new URL(req.url).pathname !== "/v1/responses" ||
        !equalSecret(req.headers.get("Authorization") ?? "", "Bearer " + key)
      )
        return new Response(null, { status: 403 });
      if (failure) return Response.json({ error: { message: failure.message } }, { status: 400 });
      try {
        const data = z
          .object({
            tools: z.array(z.unknown()),
            input: z.array(z.unknown()),
            instructions: z.string().optional(),
            reasoning: z.object({ effort: z.string().optional(), summary: z.string().optional() }).optional(),
            include: z.array(z.literal("reasoning.encrypted_content")).optional(),
          })
          .parse(await req.json());
        const catalog = data.tools.map((t) => toolset.safeParse(t)).filter((t) => t.success);
        if (catalog.length !== 1 || new Set(catalog[0].data.tools.map((t) => t.name)).size !== toolNames.length)
          throw new Error("Tool contract failed.");
        const body = {
          ...data,
          tools: [catalog[0].data],
          model: options.model,
          stream: false,
          store: false,
          parallel_tool_calls: false,
        };
        const deadline = AbortSignal.timeout(90_000);
        const upstream = await fetch(base.href.replace(/\/$/, "") + "/responses", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + (base.origin === "https://api.openai.com" ? options.apiKey : "fixture-only"),
            "Content-Type": "application/json",
          },
          redirect: "error",
          body: JSON.stringify(body),
          signal: AbortSignal.any([options.signal, deadline]),
        }).catch(() => {
          throw new RunnerError(deadline.aborted ? "deadline" : options.signal.aborted ? "interrupted" : "upstream");
        });
        if (!upstream.ok) throw await serviceError(upstream);
        const result = await upstream.json();
        if (base.origin === "https://api.openai.com" && process.env.E2E_RELEASE_METRICS === "1") {
          const measured = measuredReply.safeParse(result);
          if (measured.success) {
            const u = measured.data.usage;
            const counters = [u.input_tokens, u.output_tokens, u.total_tokens,
              u.input_tokens_details?.cached_tokens ?? 0, u.output_tokens_details?.reasoning_tokens ?? 0];
            console.error("CUTROOM_MODEL_USAGE " + counters.join(" "));
          }
        }
        const reply = modelReply.parse(result);
        for (const [id, tool] of imageReceipts(data.input)) {
          if (acknowledged.has(id)) continue;
          acknowledged.add(id);
          await options.onImageReceived(tool);
        }
        let output = event("response.created", { response: { id: reply.id } });
        for (const [index, item] of reply.output.entries()) {
          output += event("response.output_item.done", { output_index: index, item });
        }
        output += event("response.completed", {
          response: { id: reply.id, status: "completed", output: [], usage: reply.usage },
        });
        return new Response(output, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
      } catch (error) {
        failure ??= error instanceof RunnerError ? error : new RunnerError("contract");
        return Response.json({ error: { message: failure.message } }, { status: 400 });
      }
    },
  });
  return { key, url: server.url.origin + "/v1", close: () => server.stop(true), error: () => failure };
}
