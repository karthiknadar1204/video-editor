type InputItem = {
  type?: string;
  role?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  content?: unknown;
  output?: unknown;
};
type WireInput = { input: InputItem[]; tools: { type: string; name?: string; tools?: { name: string }[] }[] };

function texts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(texts);
  return value && typeof value === "object" && "text" in value && typeof value.text === "string" ? [value.text] : [];
}
function imageCount(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((n, x) => n + imageCount(x), 0);
  return value &&
    typeof value === "object" &&
    "type" in value &&
    value.type === "input_image" &&
    "image_url" in value &&
    typeof value.image_url === "string" &&
    value.image_url.startsWith("data:image/")
    ? 1
    : 0;
}
function objectResult(value: unknown): Record<string, unknown> | null {
  for (const s of texts(value)) {
    try {
      const data: unknown = JSON.parse(s);
      if (Array.isArray(data)) return objectResult(data);
      if (data && typeof data === "object") return data as Record<string, unknown>;
    } catch {
      /* Plain text tool errors have no structured result. */
    }
  }
  return null;
}

export function startFixture(port = 0) {
  const observations = { requests: 0, nativeImages: 0, toolsets: [] as string[][], held: 0 };
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/health") return Response.json({ ok: true });
      if (path === "/observations") return Response.json(observations);
      if (path !== "/v1/responses" || req.method !== "POST") return new Response(null, { status: 404 });
      const data = (await req.json()) as WireInput;
      observations.requests++;
      observations.toolsets.push(
        data.tools.flatMap((t) =>
          t.type === "namespace" ? (t.tools ?? []).map((x) => (t.name ?? "") + "." + x.name) : [t.name ?? t.type],
        ),
      );
      const requestText = data.input
        .filter((i) => i.role === "user")
        .flatMap((i) => texts(i.content))
        .slice()
        .reverse()
        .find((t) => t.startsWith("Cutroom request\n"));
      const request = requestText
        ? JSON.parse(requestText.slice("Cutroom request\n".length))
        : { prompt: "", context: {} };
      const prompt = String(request.prompt);
      const simulated = /^simulate (credit_balance_exhausted|insufficient_quota|rate_limit_exceeded)$/.exec(prompt);
      if (simulated)
        return Response.json(
          { error: { code: simulated[1], message: "Private detail from the provider" } },
          { status: 429 },
        );
      const calls = data.input.filter((i) => i.type === "function_call");
      const result = (name: string) => {
        const call = calls
          .slice()
          .reverse()
          .find((c) => c.name === name);
        if (!call) return undefined;
        return data.input
          .slice()
          .reverse()
          .find((i) => i.type === "function_call_output" && i.call_id === call.call_id)?.output;
      };
      const project = objectResult(result("read_project"));
      const selection = objectResult(result("inspect_selection"));
      const receipt = objectResult(result("update_title"));
      const frame = Math.max(
        Number((selection?.selection as { frame?: number })?.frame ?? 0),
        Number((selection?.clip as { start?: number })?.start ?? 0),
      );
      const images = data.input.reduce((n, i) => n + imageCount(i.output) + imageCount(i.content), 0);
      observations.nativeImages += images;
      const call = (name: string, args: object) => ({
        id: "fc_" + crypto.randomUUID(),
        type: "function_call",
        namespace: "mcp__cutroom",
        name,
        arguments: JSON.stringify(args),
        call_id: "call_" + crypto.randomUUID(),
      });
      const final = (text: string) => ({
        id: "msg_" + crypto.randomUUID(),
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      });
      let response: object[];
      if (prompt.includes("verify refused tool")) response = [call("read_project", {}), call("unregistered_tool", {})];
      else if (!calls.length) response = [call("read_project", {})];
      else if (!project) response = [final("Could not read the project.")];
      else if (/source contact sheet/i.test(prompt)) {
        const hits = objectResult(result("search_transcript"));
        const match = (
          hits?.matches as
            | {
                assetId: string;
                text: string;
                startMs: number;
                endMs: number;
                placements: { startFrame: number; endFrame: number }[];
              }[]
            | undefined
        )?.[0];
        const source = objectResult(result("inspect_source"));
        const edited = objectResult(result("render_frame"));
        if (!calls.some((c) => c.name === "search_transcript")) {
          const phrase = prompt.match(/["“]([^"”]+)["”]/)?.[1];
          const assetId = prompt.match(/asset ([0-9a-f-]{36})/i)?.[1];
          response = [call("search_transcript", { phrase, assetId })];
        } else if (!match) response = [final("No matching source range was found.")];
        else if (!calls.some((c) => c.name === "inspect_source"))
          response = [call("inspect_source", { assetId: match.assetId })];
        else if (source?.kind !== "source_contact_sheet" || !imageCount(result("inspect_source")))
          response = [final("The source contact sheet is unavailable.")];
        else if (edited?.kind === "committed_frame" && imageCount(result("render_frame")))
          response = [
            final(
              "The source contact sheet shows the original footage. “" +
                match.text +
                "” spans " +
                match.startMs +
                "–" +
                match.endMs +
                " ms in the source. Its timeline placements are " +
                match.placements.map((p) => p.startFrame + "–" + p.endFrame).join(", ") +
                " frames. The committed timeline frame is frame " +
                edited.frame +
                " at revision " +
                edited.revision +
                ".",
            ),
          ];
        else if (!match.placements.length || calls.filter((c) => c.name === "render_frame").length >= 6)
          response = [final("The source range is available, but I could not inspect its edited frame.")];
        else response = [call("render_frame", { revision: hits?.revision, frame: match.placements[0].startFrame })];
      } else if (!calls.some((c) => c.name === "inspect_selection")) {
        const externalArgs = {
          clipId: prompt.match(/\bclip\s+([\w-]+)/i)?.[1],
          revision: project.revision,
          frame: Number(prompt.match(/\bframe\s+(\d+)/i)?.[1] ?? 0),
        };
        response = [call("inspect_selection", request.context?.external ? externalArgs : {})];
      } else if (!selection?.clip) response = [final("There was no title to inspect.")];
      else if (!calls.some((c) => c.name === "update_title")) {
        if (/hold before edit/i.test(prompt)) {
          observations.held++;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 40_000);
            req.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
        }
        response = [
          call("update_title", {
            clipId: (selection.clip as { id: string }).id,
            revision: selection.revision,
            text: "Behind the scenes",
          }),
        ];
      } else if (!receipt) response = [final("The title edit was rejected.")];
      else if (imageCount(result("render_frame")))
        response = [final("Changed the title to Behind the scenes and inspected the saved frame.")];
      else if (calls.filter((c) => c.name === "render_frame").length >= 6)
        response = [final("The title was saved, but I could not inspect the frame.")];
      else response = [call("render_frame", { revision: receipt.revision, frame })];
      return Response.json({ id: "resp_" + crypto.randomUUID(), status: "completed", output: response });
    },
  });
}
if (import.meta.main) startFixture(Number(process.env.CUTROOM_FIXTURE_PORT ?? 4202));
