import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { textClip } from "../packages/timeline/src/model";
import { signup } from "./accounts";

test("a turn captures the editor tab and rejects a stale or missing target before calling Codex", async ({
  page,
}) => {
  await signup(page, randomUUID() + "@cutroom.test");
  const created = await page.request.post("/api/projects", { data: { title: "Cut review", format: "landscape" } });
  const path = "/api/projects/" + (await created.json()).id;
  const clip = textClip("opening", "Opening", 0, 45, 720);
  expect(
    (
      await page.request.post(path + "/edits", {
        data: { requestId: randomUUID(), expectedRevision: 0, kind: "edit", operations: [{ type: "add", clip }] },
      })
    ).ok(),
  ).toBe(true);
  const context = { tabId: randomUUID(), clipId: "opening", frame: 10, range: { from: 0, to: 45 }, revision: 0 };
  const send = (state: typeof context) =>
    page.request.post(path + "/runs", {
      data: { id: randomUUID(), prompt: "Change this to Behind the scenes.", context: state },
    });
  expect((await send(context)).status()).toBe(409);
  expect((await send({ ...context, revision: 1, clipId: "missing" })).status()).toBe(409);
  const history = await page.request.get(path + "/runs?tabId=" + context.tabId);
  expect(await history.json()).toEqual([]);
});
