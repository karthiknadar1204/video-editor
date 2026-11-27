import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { mediaClip, projectSnapshot, textClip } from "../packages/timeline/src/model";
import { signup } from "./accounts";

type Part = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

async function call(request: APIRequestContext, key: string, name: string, args: object) {
  const response = await request.post("/api/mcp", {
    headers: { Authorization: "Bearer " + key, Accept: "application/json, text/event-stream" },
    data: { jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name, arguments: args } },
  });
  expect(response.status()).toBe(200);
  const packet: { result: { content: Part[]; isError?: boolean } } = await response.json();
  const text = packet.result.content.find((part) => part.type === "text");
  if (!text || text.type !== "text") throw new Error("Missing MCP text receipt.");
  const image = packet.result.content.find((part) => part.type === "image");
  return { metadata: packet.result.isError ? null : JSON.parse(text.text), image, failed: !!packet.result.isError };
}

test("Codex finds a split source passage and distinguishes its original contact sheet from an edited frame", async ({
  page,
  request,
}) => {
  test.setTimeout(210_000);
  await signup(page, randomUUID() + "@cutroom.test");
  const createProject = async () => {
    const response = await page.request.post("/api/projects", {
      data: { title: "Interview rushes", format: "landscape" },
    });
    await expect(response).toBeOK();
    return "/api/projects/" + (await response.json()).id;
  };
  const project = await createProject();
  const bytes = await readFile("apps/web/public/media/earthrise.mp4");
  await page.goto(project.replace("/api", ""));
  await page.getByRole("button", { name: "Media library", exact: true }).click();
  await page.getByLabel("Choose footage").setInputFiles({ name: "Interview camera.mp4", mimeType: "video/mp4", buffer: bytes });
  await expect(page.getByRole("button", { name: "Insert Interview camera.mp4" })).toBeVisible({ timeout: 90_000 });
  const saved = projectSnapshot.parse(await (await page.request.get(project)).json());
  const assetId = saved.timeline.assets.find(a => a.name === "Interview camera.mp4")!.id;
  const assetPath = project + "/assets/" + assetId;

  const phrase = "Look at that picture";
  const subtitles = "WEBVTT\n\n00:01.000 --> 00:02.000\n" + phrase;
  await expect(await page.request.put(assetPath + "/analysis", { data: { revision: 0, subtitles } })).toBeOK();
  const before = await (await page.request.get(project)).json();
  const edited = await page.request.post(project + "/edits", {
    data: {
      requestId: randomUUID(),
      kind: "edit",
      expectedRevision: before.revision,
      operations: [
        { type: "add", clip: mediaClip("first", assetId, 0, 90) },
        { type: "split", id: "first", frame: 45, rightId: "second" },
        { type: "add", clip: { ...mediaClip("reprise", assetId, 120, 30), sourceStart: 30 } },
        { type: "add", clip: { ...textClip("caption", "INTERVIEW", 30, 45, 720), color: "#ff2000" } },
      ],
    },
  });
  await expect(edited).toBeOK();
  const { revision } = await edited.json();
  const connect = async (path: string) =>
    (await (await page.request.post(path + "/connection", { data: {} })).json()).key;
  const key = await connect(project);
  const hits = await call(request, key, "search_transcript", { assetId, phrase });
  expect(hits.metadata).toMatchObject({
    revision,
    nextOffset: null,
    matches: [
      {
        assetId,
        assetName: "Interview camera.mp4",
        text: phrase,
        startMs: 1000,
        endMs: 2000,
        timing: "estimated",
        placements: [
          { clipId: "first", startFrame: 30, endFrame: 45 },
          { clipId: "second", startFrame: 45, endFrame: 60 },
          { clipId: "reprise", startFrame: 120, endFrame: 150 },
        ],
      },
    ],
  });
  const ranged = await call(request, key, "search_transcript", {
    assetId,
    startMs: 1000,
    endMs: 2000,
    clipId: "second",
  });
  expect(ranged.metadata.matches[0].placements).toMatchObject([{ clipId: "second", startFrame: 45, endFrame: 60 }]);
  expect((await call(request, key, "search_transcript", { phrase, startMs: 1000, endMs: 2000 })).failed).toBe(true);
  const foreign = await connect(await createProject());
  expect((await call(request, foreign, "inspect_source", { assetId })).failed).toBe(true);
  expect((await call(request, foreign, "search_transcript", { assetId, phrase })).metadata.matches).toEqual([]);

  let source = await call(request, key, "inspect_source", { assetId });
  await expect
    .poll(
      async () => {
        if (!source.image) source = await call(request, key, "inspect_source", { assetId });
        return source.image?.type;
      },
      { timeout: 100_000, intervals: [500, 1000, 2000] },
    )
    .toBe("image");
  expect(source.metadata).toMatchObject({
    kind: "source_contact_sheet",
    assetId,
    assetName: "Interview camera.mp4",
    durationMs: 10000,
    wordCount: 4,
  });
  expect(source.metadata.timestampsMs.length).toBeGreaterThan(1);
  expect(source.metadata.timestampsMs).toEqual([...source.metadata.timestampsMs].sort((a, b) => a - b));
  expect(JSON.stringify(source.metadata)).not.toMatch(/https?:\/\/|base64|\/original/);
  expect(source.image?.mimeType).toBe("image/jpeg");
  const size = await page.evaluate(async (jpeg) => {
    const img = await createImageBitmap(await (await fetch("data:image/jpeg;base64," + jpeg)).blob());
    const dimensions = [img.width, img.height];
    img.close();
    return dimensions;
  }, source.image!.data);
  expect(Math.min(...size)).toBeGreaterThan(64);

  await page.goto(project.replace("/api", ""));
  const chat = page.getByRole("region", { name: "Edit assistant" });
  await chat
    .getByRole("textbox", { name: "Ask Codex" })
    .fill(
      'Find "' +
        phrase +
        '" in asset ' +
        assetId +
        ". Report its source time and all timeline placements. Inspect the original source contact sheet and the committed timeline frame at the first placement. Describe the distinction. Leave the timeline as it is.",
    );
  await chat.getByRole("button", { name: "Send to Codex" }).click();
  const activity = chat.getByRole("list", { name: "Activity" });
  await expect(activity).toContainText("Model received the source contact sheet", { timeout: 120_000 });
  await expect(activity).toContainText("Model received the rendered frame", { timeout: 90_000 });
  await expect(chat.getByRole("button", { name: "Stop Codex" })).toHaveCount(0, { timeout: 60_000 });
  await expect(activity).not.toContainText(phrase);
  const after = await (await page.request.get(project)).json();
  expect(after.revision).toBe(revision);
});
