import { expect, test } from "bun:test";
import { startFixture } from "../../../tests/fixtures/responses";
import { RunnerError } from "../src/client";
import { executeTurn } from "../src/codex";
import { toolNames } from "../src/provider";

test("a real Codex subprocess receives only the project namespace and examines the returned image", async () => {
  const fixture = startFixture();
  const token = crypto.randomUUID(),
    calls: string[] = [],
    activities: string[] = [];
  const mcp = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.headers.get("authorization") !== "Bearer " + token) return new Response(null, { status: 401 });
      if (req.method !== "POST") return new Response(null, { status: 405 });
      const { method, id, params } = await req.json();
      if (id === undefined) return new Response(null, { status: 202 });
      let result: unknown;
      if (method === "initialize")
        result = {
          protocolVersion: params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "cutroom", version: "1" },
        };
      else if (method === "tools/list")
        result = {
          tools: toolNames.map((name) => ({
            name,
            description: name,
            inputSchema: { type: "object", properties: {} },
          })),
        };
      else if (method === "resources/list") result = { resources: [] };
      else if (method === "resources/templates/list") result = { resourceTemplates: [] };
      else if (method === "tools/call") {
        calls.push(params.name);
        const values: Record<string, object> = {
          read_project: { revision: 2 },
          inspect_selection: {
            selection: { clipId: "closing", frame: 30 },
            clip: { id: "closing", start: 30 },
            revision: 2,
          },
          update_title: { clipId: "closing", revision: 3 },
          render_frame: { kind: "committed_frame", jobId: "frame", revision: 3, frame: 30, status: "ready" },
          search_transcript: {
            revision: 2,
            matches: [
              {
                assetId: "source",
                text: "Earthrise",
                startMs: 1000,
                endMs: 2000,
                placements: [{ startFrame: 30, endFrame: 60 }],
              },
            ],
          },
          inspect_source: { kind: "source_contact_sheet", assetId: "source", timestampsMs: [0, 1000] },
        };
        const content: object[] = [{ type: "text", text: JSON.stringify(values[params.name]) }];
        if (params.name === "render_frame" || params.name === "inspect_source")
          content.push({
            type: "image",
            mimeType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGN456JEU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAB+GUEyTNDaOAAAAAElFTkSuQmCC",
          });
        result = { content };
      }
      return Response.json({ jsonrpc: "2.0", id, result });
    },
  });
  const opts = {
    projectId: crypto.randomUUID(),
    ownerId: "owner",
    runId: crypto.randomUUID(),
    prompt: "Change this to Behind the scenes.",
    context: {},
    mcpUrl: mcp.url.origin + "/mcp",
    token,
    signal: AbortSignal.timeout(30_000),
    onEvent: (m: string) => {
      activities.push(m);
    },
  };
  const model = { model: "gpt-5.5", apiKey: "fixture-only", baseUrl: fixture.url.origin + "/v1" };
  try {
    const reply = await executeTurn(opts, model);
    expect(calls).toEqual(["read_project", "inspect_selection", "update_title", "render_frame"]);
    expect(reply).toContain("inspected the saved frame");
    expect(activities).toContain("Checking a frame from the saved revision");
    expect(activities).toContain("Model received the rendered frame");
    calls.length = 0;
    activities.length = 0;
    const review = await executeTurn(
      { ...opts, prompt: 'Find "Earthrise" and compare the source contact sheet with its committed timeline frame.' },
      model,
    );
    expect(calls).toEqual(["read_project", "search_transcript", "inspect_source", "render_frame"]);
    expect(review).toContain("1000–2000 ms in the source");
    expect(activities.filter((s) => s.startsWith("Model received"))).toEqual([
      "Model received the source contact sheet",
      "Model received the rendered frame",
    ]);
    const obs = await (await fetch(fixture.url.origin + "/observations")).json();
    expect(obs.nativeImages).toBeGreaterThan(0);
    for (const seen of obs.toolsets)
      expect(seen.toSorted()).toEqual(toolNames.map((n) => "mcp__cutroom." + n).toSorted());
    calls.length = 0;
    await expect(
      executeTurn({ ...opts, prompt: "verify refused tool", signal: AbortSignal.timeout(20_000) }, model),
    ).rejects.toThrow("verify");
    for (const [wire, code] of [
      ["credit_balance_exhausted", "credits"],
      ["insufficient_quota", "credits"],
      ["rate_limit_exceeded", "rate_limit"],
    ]) {
      const error = await executeTurn({ ...opts, prompt: "simulate " + wire }, model).catch((err) => err);
      expect(error).toBeInstanceOf(RunnerError);
      expect(error.code).toBe(code);
      expect(error.status).toBe(429);
      expect(error.message).not.toContain("Private detail");
    }
    expect(calls).toEqual([]);
  } finally {
    await Promise.all([mcp.stop(true), fixture.stop(true)]);
  }
}, 60_000);
