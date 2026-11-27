import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import postgres from "postgres";
import { textClip } from "../packages/timeline/src/model";
import { signup } from "./accounts";
import { testDatabase, webOrigin } from "./local";

const headers = { Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" };
function protocol(request: APIRequestContext, key: string, method: string, params: object) {
  return request.post("/api/mcp", { headers: { ...headers, Authorization: "Bearer " + key },
    data: { jsonrpc: "2.0", id: randomUUID(), method, params } });
}
async function tool(request: APIRequestContext, key: string, name: string, args: object) {
  const response = await protocol(request, key, "tools/call", { name, arguments: args });
  expect(response.status(), response.ok() ? "" : await response.text()).toBe(200);
  const envelope = await response.json();
  expect(envelope.error).toBeUndefined();
  return envelope.result;
}
const data = (result: { content: { text: string }[] }) => JSON.parse(result.content[0].text);

async function activeTurn(projectId: string, clipId: string, revision: number) {
  const id = randomUUID(), tabId = randomUUID();
  const key = "cut_" + randomBytes(32).toString("base64url");
  const sql = postgres(testDatabase, { max: 1 });
  try {
    await sql`INSERT INTO codex_run (id,project_id,owner_id,tab_id,context,prompt,status,token_hash,expires_at)
      SELECT ${id},id,owner_id,${tabId},${sql.json({ tabId, frame: 0, clipId, revision, range: null })},
      'Update my selected title','running',${createHash("sha256").update(key).digest("hex")},now() + interval '5 minutes' FROM project WHERE id=${projectId}`;
  } finally { await sql.end(); }
  return { id, key, tabId };
}

test("external MCP holds a single-project key, edits exactly one title and loses access on rotation or revocation", async ({ page, browser, request }) => {
  await signup(page, randomUUID() + "@cutroom.test");
  const created = await page.request.post("/api/projects", { data: { title: "Two-camera interview", format: "landscape" } });
  const { id } = await created.json();
  const path = "/api/projects/" + id;
  const initial = await page.request.post(path + "/edits", { data: { kind: "edit", requestId: randomUUID(), expectedRevision: 0, operations: [
    { type: "add", clip: textClip("opening", "Opening", 0, 30, 720) },
    { type: "add", clip: textClip("closing", "Closing", 30, 30, 720) },
  ] } });
  expect(initial.ok()).toBe(true);
  const info = async () => (await page.request.get(path + "/connection")).json();
  expect(await info()).toEqual({ connected: false, lastUsedAt: null, expiresAt: null });
  const key = (await (await page.request.post(path + "/connection", { data: {} })).json()).key;
  expect(typeof key).toBe("string");
  expect(await info()).not.toHaveProperty("key");
  expect((await page.request.post("/api/mcp", { data: {} })).status()).toBe(401);
  expect((await request.post("/api/mcp", { headers: { Authorization: "Bearer " + key, Origin: "https://other.invalid" }, data: {} })).status()).toBe(403);
  const init = await protocol(request, key, "initialize", {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "cutroom-regression", version: "1" },
  });
  expect(init.status(), init.ok() ? "" : await init.text()).toBe(200);
  expect((await init.json()).result.serverInfo.name).toBe("cutroom");
  const notification = await request.post("/api/mcp", { headers: { ...headers, Authorization: "Bearer " + key },
    data: { jsonrpc: "2.0", method: "notifications/initialized" } });
  expect(notification.status()).toBe(202);
  const tools = (await (await protocol(request, key, "tools/list", {})).json()).result.tools;
  expect(tools.map((t: { name: string }) => t.name).sort()).toEqual(["inspect_selection", "list_assets", "read_project", "render_frame", "update_title"]);
  expect((await info()).lastUsedAt).toBeTruthy();
  expect(data(await tool(request, key, "read_project", {}))).toMatchObject({ id, revision: 1, clips: { total: 2 } });
  expect(data(await tool(request, key, "list_assets", {})).assets.total).toBeGreaterThan(0);
  expect((await tool(request, key, "inspect_selection", {})).isError).toBe(true);
  expect(data(await tool(request, key, "inspect_selection", { clipId: "closing", frame: 35, revision: 1 })).clip.text).toBe("Closing");
  const change = { clipId: "closing", revision: 1, text: "Behind the scenes" };
  const receipt = data(await tool(request, key, "update_title", change));
  expect(receipt).toMatchObject({ clipId: "closing", revision: 2 });
  expect(data(await tool(request, key, "update_title", change))).toEqual(receipt);
  expect((await tool(request, key, "update_title", { ...change, clipId: "opening" })).isError).toBe(true);
  const current = async () => (await page.request.get(path)).json();
  expect((await current()).timeline.clips.map((c: {text: string}) => c.text)).toEqual(["Opening", "Behind the scenes"]);
  expect((await page.request.post(path + "/edits", { data: { kind: "undo", requestId: randomUUID(), expectedRevision: 2 } })).ok()).toBe(true);
  expect((await current()).timeline.clips[1].text).toBe("Closing");

  const another = await browser.newContext({ baseURL: webOrigin });
  try {
    await signup(await another.newPage(), randomUUID() + "@cutroom.test");
    for (const method of ["GET", "POST", "DELETE"]) {
      const response = await another.request.fetch(path + "/connection", { method, ...(method === "POST" ? { data: {} } : {}) });
      expect(response.status()).toBe(404);
    }
  } finally { await another.close(); }
  const replacement = (await (await page.request.post(path + "/connection", { data: {} })).json()).key;
  expect((await protocol(request, key, "tools/list", {})).status()).toBe(401);
  expect((await protocol(request, replacement, "tools/list", {})).status()).toBe(200);
  const concurrent = { name: "update_title", arguments: { clipId: "closing", revision: 3, text: "Final cut" } };
  const [write, revoke] = await Promise.all([
    protocol(request, replacement, "tools/call", concurrent),
    page.request.delete(path + "/connection"),
  ]);
  expect(revoke.status()).toBe(200);
  expect([200, 401]).toContain(write.status());
  const savedBeforeRevoke = write.ok() && !(await write.json()).result.isError;
  const final = await current();
  expect(final.revision).toBe(savedBeforeRevoke ? 4 : 3);
  expect(final.timeline.clips[1].text).toBe(savedBeforeRevoke ? "Final cut" : "Closing");
  expect((await protocol(request, replacement, "tools/list", {})).status()).toBe(401);
  expect((await info()).connected).toBe(false);
});

test("a turn's captured tab, clip and revision govern every MCP title edit", async ({ page, request }) => {
  await signup(page, randomUUID() + "@cutroom.test");
  const create = await page.request.post("/api/projects", { data: { title: "Captured selection", format: "portrait" } });
  const { id } = await create.json();
  const path = "/api/projects/" + id;
  const edit = (expectedRevision: number, operations: object[]) => page.request.post(path + "/edits", { data: {
    kind: "edit", expectedRevision, requestId: randomUUID(), operations,
  } });
  expect((await edit(0, [{ type: "add", clip: textClip("shot-a", "A", 0, 30, 1280) },
    { type: "add", clip: textClip("shot-b", "B", 30, 30, 1280) }])).ok()).toBe(true);
  const { key, tabId } = await activeTurn(id, "shot-a", 1);
  const selection = data(await tool(request, key, "inspect_selection", {}));
  expect(selection.selection).toMatchObject({ tabId, clipId: "shot-a", revision: 1 });
  expect((await tool(request, key, "update_title", { clipId: "shot-b", revision: 1, text: "Wrong" })).isError).toBe(true);
  expect((await edit(1, [{ type: "text", id: "shot-b", text: "Edited in another tab" }])).ok()).toBe(true);
  const change = { clipId: "shot-a", revision: 2, text: "Behind the scenes" };
  expect((await tool(request, key, "update_title", { ...change, revision: 1 })).isError).toBe(true);
  expect((await tool(request, key, "update_title", change)).isError).toBe(true);
  expect(data(await tool(request, key, "read_project", {})).revision).toBe(2);
  const saved = data(await tool(request, key, "update_title", change));
  expect(saved.revision).toBe(3);
  expect(data(await tool(request, key, "read_project", {})).revision).toBe(3);
  expect(data(await tool(request, key, "update_title", change))).toEqual(saved);
  expect((await tool(request, key, "update_title", { ...change, revision: 3, text: "Another edit" })).isError).toBe(true);
  const latest = await (await page.request.get(path)).json();
  expect(latest.revision).toBe(3);
  expect(latest.timeline.clips.map((c: { text: string }) => c.text)).toEqual(["Behind the scenes", "Edited in another tab"]);
});

test("Stop immediately after a committed MCP edit preserves its single receipt and rejects future tools", async ({ page, request }) => {
  await signup(page, randomUUID() + "@cutroom.test");
  const created = await page.request.post("/api/projects", { data: { title: "Stop after save", format: "landscape" } });
  const { id } = await created.json(), path = "/api/projects/" + id;
  const clip = textClip("opening", "Opening", 0, 30, 720);
  await expect(await page.request.post(path + "/edits", { data: { kind: "edit", requestId: randomUUID(), expectedRevision: 0, operations: [{ type: "add", clip }] } })).toBeOK();
  const run = await activeTurn(id, clip.id, 1), runPath = path + "/runs/" + run.id;
  const change = { clipId: clip.id, revision: 1, text: "Behind the scenes" };
  const saved = data(await tool(request, run.key, "update_title", change));
  expect((await page.request.delete(runPath)).status()).toBe(204);
  const stopped = await (await page.request.get(runPath)).json();
  expect(stopped).toMatchObject({ status: "stopped", receipt: { requestId: saved.requestId, revision: 2, affected: saved.affected } });
  expect(stopped.events.filter((e: { text: string }) => e.text.includes("Title saved"))).toHaveLength(1);
  const retry = await protocol(request, run.key, "tools/call", { name: "update_title", arguments: { ...change, revision: 2, text: "Too late" } });
  expect(retry.status()).toBe(401);
  expect((await page.request.delete(runPath)).status()).toBe(204);
  expect((await (await page.request.get(path)).json()).timeline.clips[0].text).toBe(change.text);
  await expect(await page.request.post(path + "/edits", { data: { kind: "undo", expectedRevision: 2, requestId: randomUUID() } })).toBeOK();
  const undone = await (await page.request.get(path)).json();
  expect(undone).toMatchObject({ revision: 3, timeline: { clips: [{ text: "Opening" }] } });
  expect(await (await page.request.get(runPath)).json()).toEqual(stopped);
});

test("a captured title removed by another editor cannot be retargeted, even if its ID is reused", async ({ page, request }) => {
  await signup(page, randomUUID() + "@cutroom.test");
  const created = await page.request.post("/api/projects", { data: { title: "Removed selection", format: "landscape" } });
  const { id } = await created.json(), path = "/api/projects/" + id;
  const edit = (expectedRevision: number, operations: object[]) => page.request.post(path + "/edits", { data: {
    kind: "edit", expectedRevision, requestId: randomUUID(), operations,
  } });
  const clip = textClip("opening", "Opening", 0, 30, 720);
  await expect(await edit(0, [{ type: "add", clip }])).toBeOK();
  const run = await activeTurn(id, clip.id, 1);
  await expect(await edit(1, [{ type: "delete", id: clip.id }])).toBeOK();
  expect(data(await tool(request, run.key, "inspect_selection", {})).clip).toBeNull();
  const change = { clipId: clip.id, revision: 2, text: "Wrong target" };
  expect((await tool(request, run.key, "update_title", change)).isError).toBe(true);
  await expect(await edit(2, [{ type: "add", clip: { ...clip, text: "A different opening" } }])).toBeOK();
  expect(data(await tool(request, run.key, "read_project", {})).revision).toBe(3);
  expect(data(await tool(request, run.key, "inspect_selection", {})).clip).toBeNull();
  expect((await tool(request, run.key, "update_title", { ...change, revision: 3 })).isError).toBe(true);
  const latest = await (await page.request.get(path)).json();
  expect(latest).toMatchObject({ revision: 3, timeline: { clips: [{ text: "A different opening" }] } });
  const turn = await (await page.request.get(path + "/runs/" + run.id)).json();
  expect(turn.receipt).toBeNull();
});
