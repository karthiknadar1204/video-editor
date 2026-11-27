import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { mediaClip, rushes, textClip } from "../packages/timeline/src/model";
import { signup } from "./accounts";

test("a concurrent edit rebases the candidate, commits once, and targeted undo respects later edits", async ({ page, request }) => {
  await signup(page, randomUUID() + "@cutroom.test");
  const create = await page.request.post("/api/projects", { data: { title: "Review race", format: "landscape" } });
  const root = "/api/projects/" + (await create.json()).id, drafts = root + "/rough-cuts", transcript = root + "/assets/" + rushes.id + "/analysis";
  const edit = (revision: number, operations: object[]) => page.request.post(root + "/edits", { data: { kind: "edit", requestId: randomUUID(), expectedRevision: revision, operations } });
  await expect(await edit(0, [{ type: "add", clip: mediaClip("take", rushes.id, 0, 120) }])).toBeOK();
  await expect(await page.request.put(transcript, { data: { revision: 0, subtitles: "WEBVTT\n\n00:00.000 --> 00:00.500\nStart\n\n00:03.000 --> 00:03.600\nAgain" } })).toBeOK();
  for (const [index, startMs, endMs] of [[0, 0, 500], [1, 3000, 3600]]) {
    await expect(await page.request.put(transcript, { data: { revision: index + 1, index, correction: { startMs, endMs } } })).toBeOK();
  }
  const id = randomUUID(), path = drafts + "/" + id;
  const input = { requestId: id, options: { target: { clipId: "take" }, pauseThresholdMs: 800, breathingRoomMs: 100 } };
  const first = await page.request.post(drafts, { data: input });
  await expect(first).toBeOK();
  expect(await first.json()).toMatchObject({ status: "draft", baseRevision: 1, receipt: { pauseCount: 1 } });
  await expect(await page.request.post(drafts, { data: input })).toBeOK();
  expect((await page.request.post(drafts, { data: { ...input, options: { ...input.options, breathingRoomMs: 500 } } })).status()).toBe(409);
  expect((await request.get(path)).status()).toBe(401);
  await expect(await edit(1, [{ type: "add", clip: textClip("title", "New title", 0, 30, 720) }])).toBeOK();
  const commit = (expectedRevision: number) => page.request.post(path + "/commit", { data: { expectedRevision } });
  expect(await (await commit(1)).json()).toMatchObject({ rebased: true, receipt: null, review: { baseRevision: 2, status: "draft" } });
  expect((await (await page.request.get(root)).json()).revision).toBe(2);
  const [a, b] = await Promise.all([commit(2), commit(2)]);
  await expect(a).toBeOK(); await expect(b).toBeOK();
  const committed = await a.json();
  expect((await b.json()).receipt).toEqual(committed.receipt);
  expect(committed).toMatchObject({ rebased: false, receipt: { revision: 3 }, review: { status: "applied", canUndoReview: true } });
  expect(committed.review.receipt).not.toHaveProperty("context");
  const forged = await edit(3, [{ type: "roughCut", reviewId: id, put: [], remove: ["title"] }]);
  expect([400, 422]).toContain(forged.status());
  await expect(await edit(3, [{ type: "text", id: "title", text: "Keep my edit" }])).toBeOK();
  expect((await page.request.post(path + "/undo", { data: { expectedRevision: 4, requestId: randomUUID() } })).status()).toBe(409);
  const cut = committed.review.receipt.cuts[0];
  const restoreInput = { requestId: randomUUID(), expectedRevision: 4, cutId: cut.id };
  const restore = () => page.request.post(path + "/restore", { data: restoreInput });
  expect(await (await restore()).json()).toMatchObject({ revision: 5 });
  expect(await (await restore()).json()).toMatchObject({ revision: 5 });
  expect((await (await page.request.get(root)).json()).timeline.clips.find((c: {id:string}) => c.id === "title").text).toBe("Keep my edit");
  await expect(await page.request.post(path + "/undo", { data: { expectedRevision: 5, requestId: randomUUID() } })).toBeOK();
  expect(await (await page.request.get(path)).json()).toMatchObject({ restoredIds: [], status: "applied", canUndoReview: false });
  for (let i = 0; i < 30; i++) {
    await expect(await page.request.post(drafts, { data: { ...input, requestId: randomUUID() } })).toBeOK();
  }
  const firstPage = await (await page.request.get(drafts)).json();
  expect(firstPage.reviews).toHaveLength(30);
  const older = await (await page.request.get(drafts + "?offset=" + firstPage.nextOffset)).json();
  expect(older).toMatchObject({ reviews: [{ id, status: "applied" }], nextOffset: null });
});
