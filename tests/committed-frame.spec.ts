import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { mediaClip, projectSnapshot, textClip } from "../packages/timeline/src/model";
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
  let release!: () => void;
  let acquired!: () => void;
  const acquiredLock = new Promise<void>(r => { acquired = r; });
  const hold = new Promise<void>(r => { release = r; });
  const blocking = sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtext('cutroom.frame.renderer'))`;
    acquired();
    await hold;
  });
  try {
    await acquiredLock;
    const [first, retry] = await Promise.all([tool(revision, 15), tool(revision, 15)]);
    expect(meta(first)).toMatchObject({ frame:15, revision, timestampMs:500, status:"queued" });
    expect(meta(retry)).toEqual(meta(first));
    const [usage] = await sql`select count from agent_usage where owner_id = (select id from "user" where email = ${email}) and kind = 'render'`;
    expect(usage.count).toBe(1);
    const moved = await page.request.post(project+"/edits", {data:{kind:"edit", expectedRevision:revision, requestId:randomUUID(),
      operations:[{type:"position",id:"title",x:2000,y:0}]}});
    expect(moved.ok()).toBe(true);
    // Recreate the state left by a stopped worker. Its transaction lock is gone when this transaction exits.
    await sql`update frame_job set status='running' where id=${meta(first).jobId}`;
    await sql`update agent_usage set count=2147483000 where owner_id=(select id from "user" where email=${email}) and kind='render'`;
    release();
    await blocking;
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
    release();
    await blocking;
    await sql.end();
  }
});
