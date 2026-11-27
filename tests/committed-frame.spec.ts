import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { mediaClip, projectSnapshot, rushes, textClip } from "../packages/timeline/src/model";
import { signup } from "./accounts";
import { testDatabase } from "./local";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

test("a queued Codex frame survives edits and worker recovery, returns private pixels, and charges one render", async ({ page }) => {
  const email = randomUUID()+"@cutroom.test";
  await signup(page, email);
  const made = await page.request.post("/api/projects", { data: { title: "Camera review", format: "landscape" } });
  const { id } = await made.json();
  const project = "/api/projects/"+id;
  await page.goto("/projects/"+id);
  await page.getByRole("button", { name: "Add footage" }).click();
  const media = page.getByRole("dialog", { name: "Media library" });
  await media.getByLabel("Choose footage").setInputFiles({ name:"Lunar orbit.mp4", mimeType:"video/mp4", buffer:await readFile("apps/web/public/media/earthrise.mp4") });
  await expect(media.getByRole("button", { name:"Insert Lunar orbit.mp4" })).toBeVisible({ timeout: 60_000 });
  await media.getByRole("button", { name: "Close media library" }).click();
  const snapshot = projectSnapshot.parse(await (await page.request.get(project)).json());
  const asset = snapshot.timeline.assets.find(a => a.name === "Lunar orbit.mp4");
  if (!asset) throw new Error("Missing uploaded source.");
  const add = await page.request.post(project+"/edits", {data:{kind:"edit", expectedRevision:snapshot.revision, requestId:randomUUID(), operations:[
    {type:"add",clip:mediaClip("footage",asset.id,0,30)},
    {type:"add",clip:{...textClip("title","ORBIT",0,30,720),color:"#ff2000",x:40,y:20}},
  ]}});
  expect(add.ok()).toBe(true);
  const revision = (await add.json()).revision;
  const key = (await (await page.request.post(project+"/connection", {data:{}})).json()).key;
  const tool = async (revision: number, frame: number) => {
    const response = await page.request.post("/api/mcp", { headers: { Authorization:"Bearer "+key, Accept:"application/json, text/event-stream" },
      data:{jsonrpc:"2.0",id:randomUUID(),method:"tools/call",params:{name:"render_frame",arguments:{revision,frame}}} });
    expect(response.ok()).toBe(true);
    const packet: { result: { content: Content[]; isError?: boolean } } = await response.json();
    expect(packet.result.content).toEqual(expect.any(Array));
    return packet.result;
  };
  const meta = (result: Awaited<ReturnType<typeof tool>>) => {
    const item = result.content.find(i => i.type === "text");
    if (!item || item.type !== "text") throw new Error("Missing frame receipt.");
    const receipt: { jobId: string; status: string; frame: number; revision: number; timestampMs: number } = JSON.parse(item.text);
    expect(receipt.jobId).toEqual(expect.any(String));
    return receipt;
  };
  const sql = postgres(testDatabase, { max: 3, prepare:false });
  try {
    const original = projectSnapshot.parse(await (await page.request.get(project)).json());
    const [first, retry] = await Promise.all([tool(revision, 15), tool(revision, 15)]);
    expect(meta(first)).toMatchObject({ frame:15, revision, timestampMs:500 });
    expect(meta(retry).jobId).toBe(meta(first).jobId);
    await expect.poll(async () => {
      const [entry] = await sql`select status from frame_job where id=${meta(first).jobId}`;
      return entry?.status;
    }, { timeout: 60_000 }).toBe("ready");
    const [usage] = await sql`select count from agent_usage where owner_id = (select id from "user" where email = ${email}) and kind = 'render'`;
    expect(usage.count).toBe(1);
    const moved = await page.request.post(project+"/edits", {data:{kind:"edit", expectedRevision:revision, requestId:randomUUID(),
      operations:[{type:"position",id:"title",x:2000,y:0}]}});
    expect(moved.ok()).toBe(true);
    // Recreate an expired claim on this fixture's saved revision, after the owner has changed its live timeline.
    await sql`update frame_job set status='running', data=null, timeline=${JSON.stringify(original.timeline)}::jsonb,
      updated_at=now()-interval '3 minutes' where id=${meta(first).jobId}`;
    await sql`update agent_usage set count=2147483000 where owner_id=(select id from "user" where email=${email}) and kind='render'`;
    const denied = await tool(revision+1,15);
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.content)).toContain("allowance");
    const stale = await tool(revision, 16);
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale.content)).toContain("revision");
    let rendered = await tool(revision,15);
    await expect.poll(async () => {
      if (meta(rendered).status !== "ready") rendered = await tool(revision,15);
      return meta(rendered).status;
    }, {timeout:60_000}).toBe("ready");
    const image = rendered.content.find(i => i.type === "image");
    if (!image || image.type !== "image") throw new Error("Missing MCP image attachment.");
    expect(image.mimeType).toBe("image/jpeg");
    const view = await page.evaluate(async data => {
      const bitmap = await createImageBitmap(await (await fetch("data:image/jpeg;base64,"+data)).blob());
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width; canvas.height=bitmap.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bitmap,0,0);
      const rgba=ctx.getImageData(0,0,canvas.width,canvas.height).data;
      let red=0, lit=0;
      for (let i=0;i<rgba.length;i+=4) {
        if (i<canvas.width*100*4 && rgba[i]>150 && rgba[i+1]<95 && rgba[i+2]<95) red++;
        if (i>canvas.width*100*4 && rgba[i+2]>100) lit++;
      }
      bitmap.close();
      return {width:canvas.width,height:canvas.height,red,lit};
    },image.data);
    expect(view).toMatchObject({width:960,height:540});
    expect(view.red).toBeGreaterThan(150);
    expect(view.lit).toBeGreaterThan(500);
    const cached = await tool(revision,15);
    expect(meta(cached).jobId).toBe(meta(first).jobId);
    expect(cached.content.find(i => i.type === "image")).toEqual(image);
  } finally {
    await sql.end();
  }
});

test("concurrent candidate frame requests return and cache each frame's own pixels", async ({ page }) => {
  await signup(page, randomUUID() + "@cutroom.test");
  const create = await page.request.post("/api/projects", { data: { title: "Frame comparison", format: "landscape" } });
  const path = "/api/projects/" + (await create.json()).id;
  const clips = [mediaClip("interview", rushes.id, 0, 60), textClip("first", "First frame", 0, 30, 720), textClip("second", "Second frame", 30, 30, 720)];
  const edit = await page.request.post(path + "/edits", { data: { kind: "edit", expectedRevision: 0, requestId: randomUUID(),
    operations: clips.map(clip => ({ type: "add", clip })) } });
  expect(edit.status()).toBe(200);
  const imported = await page.request.put(path + "/assets/" + rushes.id + "/analysis", { data: { revision: 0, subtitles: "WEBVTT\n\n00:00.000 --> 00:00.700\nHello" } });
  expect(imported.status()).toBe(204);
  const reviewId = randomUUID();
  const preview = await page.request.post(path + "/rough-cuts", { data: { requestId: reviewId, options: { target: { clipId: "interview" }, captions: false } } });
  expect(preview.status()).toBe(201);
  const { key } = await (await page.request.post(path + "/connection", { data: {} })).json();
  async function pixels(frame: number) {
    let hash = "";
    await expect.poll(async () => {
      const response = await page.request.post("/api/mcp", { headers: { Authorization: "Bearer " + key, Accept: "application/json, text/event-stream" },
        data: { jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name: "rough_cut", arguments: { action: "inspect", reviewId, frame } } } });
      const { result }: { result: { content: Content[]; isError?: boolean } } = await response.json();
      const meta = result.content.find(part => part.type === "text");
      if (result.isError && meta?.type === "text" && meta.text.includes("busy")) return false;
      expect(result.isError).not.toBe(true);
      const jpeg = result.content.find(part => part.type === "image");
      if (!jpeg || jpeg.type !== "image" || meta?.type !== "text") throw new Error("Expected a candidate frame image.");
      expect(JSON.parse(meta.text)).toMatchObject({ reviewId, frame, baseRevision: 1 });
      hash = createHash("sha256").update(Buffer.from(jpeg.data, "base64")).digest("hex");
      return true;
    }, { timeout: 75_000 }).toBe(true);
    return hash;
  }
  const [first, second] = await Promise.all([pixels(10), pixels(40)]);
  expect(first).not.toBe(second);
  expect(await Promise.all([pixels(40), pixels(10)])).toEqual([second, first]);
});
