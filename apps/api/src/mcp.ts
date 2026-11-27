import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { EditError } from "@editor/timeline";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { appOrigin } from "./auth";
import { AllowanceError } from "./allowance";
import { acknowledgeRead, authorizeEdit, markConnected, resolveProjectKey, selectionWasRemoved, type ProjectAccess } from "./codex-access";
import { recordEdit, recordTool } from "./codex-runs-store";
import { requestFrame, FrameError } from "./frames";
import { getProject, HistoryError, saveEdit } from "./history";

const frameNumber = z.int().nonnegative();
const clipId = z.string().min(1).max(200);
const pagination = { offset: z.int().nonnegative().default(0) };
const pageSize = 30;
const textResult = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

function page<T>(items: T[], offset: number) {
  return { items: items.slice(offset, offset + pageSize), total: items.length, nextOffset: offset + pageSize < items.length ? offset + pageSize : null };
}

function editId(access: ProjectAccess, revision: number, id: string, text: string) {
  if (access.kind === "run") return access.id;
  const bytes = createHash("sha256").update(JSON.stringify([access.projectId, revision, id, text])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x80;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

function errorText(error: unknown) {
  if (error instanceof HistoryError) return error.message + (error.revision === undefined ? "" : " Current revision " + error.revision + ".");
  if (error instanceof EditError || error instanceof FrameError || error instanceof AllowanceError) return error.message;
  return "The editor could not complete this tool request.";
}

function editorServer(access: ProjectAccess) {
  const server = new McpServer({ name: "cutroom", version: "1.0.0" }, {
    instructions: "Use the authorized project only. Read its current state, inspect the requested title, update it at that revision, then inspect a frame containing the edit. A queued frame can be polled with the same arguments.",
  });
  async function snapshot() {
    const project = await getProject(access.projectId, access.ownerId);
    if (!project) throw new HistoryError(404, "Project not found.");
    return project;
  }
  async function call(name: string, work: () => Promise<{ result: CallToolResult; detail: string }>): Promise<CallToolResult> {
    try {
      const { result, detail } = await work();
      if (access.kind === "run" && name !== "update_title") await recordTool(access.id, name, detail);
      return result;
    } catch (error) {
      const message = errorText(error);
      if (access.kind === "run") await recordTool(access.id, name, message);
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  }
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  server.registerTool("read_project", {
    description: "Read the project, canvas, committed revision and a page of timeline clips. Use nextOffset to read further.",
    inputSchema: pagination, annotations: readOnly,
  }, ({ offset }) => call("read_project", async () => {
    const { id, title, revision, timeline } = await snapshot();
    await acknowledgeRead(access, revision);
    const { width, height, fps, durationInFrames, lockedTracks } = timeline;
    return { result: textResult({ id, title, revision, width, height, fps, durationInFrames, lockedTracks, clips: page(timeline.clips, offset) }),
      detail: "Read revision " + revision };
  }));
  server.registerTool("list_assets", {
    description: "List source assets available to this project with names, frame durations and media metadata. Delivery URLs are private.",
    inputSchema: pagination, annotations: readOnly,
  }, ({ offset }) => call("list_assets", async () => {
    const { revision, timeline } = await snapshot();
    const assets = timeline.assets.map(({ id, name, duration, metadata }) => ({
      id, name, duration, mediaType: metadata?.mediaType ?? "video", width: metadata?.width, height: metadata?.height,
      hasAudio: metadata?.hasAudio, transcript: metadata?.transcript,
    }));
    return { result: textResult({ revision, assets: page(assets, offset) }), detail: "Listed " + assets.length + " assets" };
  }));
  server.registerTool("inspect_selection", {
    description: access.kind === "run" ? "Read the clip, range and playhead captured in this editor tab when the user sent the request."
      : "Inspect one explicitly identified clip at the given frame and committed revision. External connections do not inherit a tab's selection.",
    inputSchema: { clipId: clipId.optional(), revision: frameNumber.optional(), frame: frameNumber.optional() }, annotations: readOnly,
  }, args => call("inspect_selection", async () => {
    const { revision, timeline } = await snapshot();
    let selection;
    if (access.kind === "run") {
      selection = access.context;
    } else {
      if (args.clipId === undefined || args.revision === undefined || args.frame === undefined) throw new HistoryError(422, "Supply clipId, revision and frame.");
      if (args.revision !== revision) throw new HistoryError(409, "Read the current project before inspecting this clip.", revision);
      if (args.frame >= Math.max(1, timeline.durationInFrames)) throw new HistoryError(422, "The frame is outside this project.");
      selection = { clipId: args.clipId, frame: args.frame, revision: args.revision, tabId: null, range: null };
    }
    const deleted = access.kind === "run" && await selectionWasRemoved(access, revision);
    const clip = deleted ? null : timeline.clips.find(c => c.id === selection.clipId) ?? null;
    if (!clip && access.kind === "external") throw new HistoryError(404, "The requested clip does not exist.");
    await acknowledgeRead(access, revision);
    return { result: textResult({ revision, selection, clip }), detail: clip ? "Inspected the selected clip" : "No matching clip is selected" };
  }));
  server.registerTool("update_title", {
    description: "Set the text of one title clip at the supplied committed revision. A turn can change only its captured title. On conflict, read the current project. Repeating identical arguments safely returns the original receipt.",
    inputSchema: { clipId, revision: frameNumber, text: z.string().trim().min(1).max(2000) },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, args => call("update_title", async () => {
    const current = await snapshot();
    if (args.revision > current.revision) throw new HistoryError(409, "Read the current project before editing.", current.revision);
    if (current.revision === args.revision) {
      if (access.kind === "run" && await selectionWasRemoved(access, args.revision)) {
        throw new HistoryError(409, "The captured title was removed. Select a title and start a new turn.");
      }
      const selected = current.timeline.clips.find(c => c.id === args.clipId);
      if (selected?.track !== "title") throw new HistoryError(422, "The selected clip must be an existing title.");
    }
    const receipt = await saveEdit(access.projectId, access.ownerId, {
      kind: "edit", expectedRevision: args.revision, requestId: editId(access, args.revision, args.clipId, args.text),
      operations: [{ type: "text", id: args.clipId, text: args.text }],
    }, {
      before: tx => authorizeEdit(tx, access, args.clipId, args.revision),
      after: access.kind === "run" ? (tx, saved) => recordEdit(tx, access.id, saved) : undefined,
    });
    return { result: textResult({ clipId: args.clipId, ...receipt }), detail: "Saved revision " + receipt.revision };
  }));
  server.registerTool("render_frame", {
    description: "Inspect an image from one explicit committed revision and zero-based timeline frame. If the job is queued or running, repeat the same arguments to get its image without starting another job.",
    inputSchema: { revision: frameNumber, frame: frameNumber }, annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (args, extra) => call("render_frame", async () => {
    const target = { ownerId: access.ownerId, projectId: access.projectId, ...args };
    const deadline = Date.now() + 8_000;
    let job = await requestFrame(target);
    while ((job.status === "queued" || job.status === "running") && Date.now() < deadline && !extra.signal.aborted) {
      await delay(400, undefined, { signal: extra.signal });
      job = await requestFrame(target);
    }
    if (job.status === "failed") throw new EditError(job.error);
    const { jobId, status, revision, frame, timestampMs } = job;
    const result = textResult({ jobId, status, revision, frame, timestampMs });
    if (job.status === "ready") result.content.push({ type: "image", mimeType: job.mimeType, data: job.data });
    return { result, detail: "Frame " + frame + " at revision " + revision + " · " + status };
  }));
  return server;
}

export const mcp = new Hono();
mcp.use("*", bodyLimit({ maxSize: 64 * 1024 }));
mcp.all("/", async c => {
  c.header("Cache-Control", "private, no-store");
  const origin = c.req.header("Origin");
  if (origin && origin !== appOrigin) return c.json({ error: "Origin is not allowed." }, 403);
  const access = await resolveProjectKey(c.req.header("Authorization"));
  if (!access) {
    c.header("WWW-Authenticate", 'Bearer realm="Cutroom"');
    return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "A current project credential is required." } }, 401);
  }
  if (c.req.method !== "POST") {
    c.header("Allow", "POST");
    return c.body(null, 405);
  }
  let parsedBody: unknown;
  try {
    parsedBody = await c.req.json();
  } catch {
    return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON." } }, 400);
  }
  const server = editorServer(access);
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(c.req.raw, { parsedBody });
    response.headers.set("Cache-Control", "private, no-store");
    if (response.ok) await markConnected(access);
    return response;
  } finally { await server.close(); }
});
