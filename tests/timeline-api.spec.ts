import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { mediaClip, rushes } from "../packages/timeline/src/model";
import { signup } from "./accounts";

test("edit retries, concurrent writers, atomic groups and redo branching use durable revisions", async ({ page }) => {
  await signup(page, randomUUID() + "@cutroom.test");
  const created = await page.request.post("/api/projects", { data: { title: "Concurrency test", format: "landscape" } });
  const path = "/api/projects/" + (await created.json()).id;
  const post = (data: object) => page.request.post(path + "/edits", { data });
  const state = async () => (await page.request.get(path)).json();
  const add = { kind: "edit", expectedRevision: 0, requestId: randomUUID(), operations: [
    { type: "add", clip: { ...mediaClip("picture", rushes.id, 150, 150), sourceStart: 360 } },
  ] };
  expect((await post(add)).status()).toBe(200);
  const split = { kind: "edit", expectedRevision: 1, requestId: randomUUID(), operations: [{ type: "split", id: "picture", frame: 210, rightId: "second" }] };
  const duplicates = await Promise.all([post(split), post(split)]);
  expect(duplicates.map(r => r.status())).toEqual([200, 200]);
  expect(await duplicates[1].json()).toEqual(await duplicates[0].json());
  expect(await state()).toMatchObject({ revision: 2, timeline: { clips: [{ sourceStart: 360, duration: 60 }, { sourceStart: 420, start: 210 }] } });
  expect((await post({ ...split, expectedRevision: 2 })).status()).toBe(409);
  const rejected = await post({ kind: "edit", expectedRevision: 2, requestId: randomUUID(), operations: [
    { type: "delete", id: "second" }, { type: "trim", id: "picture", edge: "right", frame: 8999 },
  ] });
  expect(rejected.status()).toBe(422);
  expect((await state()).timeline.clips).toHaveLength(2);
  const concurrent = await Promise.all(["picture", "second"].map(id => post({ kind: "edit", expectedRevision: 2, requestId: randomUUID(),
    operations: [{ type: "volume", id, volume: .5 }] })));
  expect(concurrent.map(r => r.status()).sort()).toEqual([200, 409]);
  const undo = { kind: "undo", expectedRevision: 3, requestId: randomUUID() };
  expect((await post(undo)).status()).toBe(200);
  expect((await post(undo)).status()).toBe(200);
  expect(await state()).toMatchObject({ revision: 4, canRedo: true, timeline: { clips: [{ volume: 1 }, { volume: 1 }] } });
  expect((await post({ kind: "undo", expectedRevision: 4, requestId: randomUUID() })).status()).toBe(200);
  expect((await post({ kind: "redo", expectedRevision: 5, requestId: randomUUID() })).status()).toBe(200);
  expect((await state()).timeline.clips).toHaveLength(2);
  await expect(await post({ kind: "edit", expectedRevision: 6, requestId: randomUUID(), operations: [{ type: "delete", id: "second" }] })).toBeOK();
  expect((await post({ kind: "redo", expectedRevision: 7, requestId: randomUUID() })).status()).toBe(422);
  expect((await post(split)).status()).toBe(200);
  expect(await state()).toMatchObject({ revision: 7, canRedo: false });
});
