import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { signup } from "./accounts";
import { testDatabase } from "./local";

test("a private speech recording becomes searchable, and recovery keeps the original and reviewed words", async ({ page }) => {
  const fixturePath = resolve(process.env.CUTROOM_WHISPER_DIR ?? ".local/whisper-1.8.3", "source/samples/jfk.wav");
  test.skip(process.env.CUTROOM_TEST_WHISPER !== "1" && !existsSync(fixturePath), "Install the pinned speech worker to exercise local recognition.");
  await signup(page, randomUUID() + "@cutroom.test");
  const response = await page.request.post("/api/projects", { data: { title: "Speech archive", format: "landscape" } });
  const { id } = await response.json();
  await page.goto("/projects/" + id);
  await page.getByRole("button", { name: "Media library", exact: true }).click();
  await page.getByLabel("Choose footage").setInputFiles({ name: "Inauguration.wav", mimeType: "audio/wav", buffer: await readFile(fixturePath) });
  const inspect = page.getByRole("button", { name: "Inspect Inauguration.wav" });
  await expect(inspect).toBeVisible({ timeout: 90_000 });
  await inspect.click();
  await expect(page.getByText("Machine transcript", { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole("img", { name: "Source contact sheet" })).toHaveCount(0);
  await page.getByLabel("Find a phrase").fill("ask not what your country");
  await page.getByRole("button", { name: "Search transcript" }).click();
  await expect(page.getByText("No surviving use on this timeline.")).toBeVisible();
  const root = "/api/projects/" + id;
  const saved = await (await page.request.get(root)).json();
  const assetId = saved.timeline.assets.find((a: {name: string}) => a.name === "Inauguration.wav").id;
  const path = root + "/assets/" + assetId + "/analysis";
  const original = await (await page.request.get(path + "?view=original")).json();
  expect(original).toMatchObject({ status: "ready", transcriptStatus: "transcribed", hasAudio: true, revision: 0, hasOriginal: true, timestampsMs: [] });
  expect(original.words.length).toBeGreaterThan(18);
  await expect(await page.request.put(path, { data: { revision: 0, index: 0, correction: { text: "Reviewed" } } })).toBeOK();

  // Simulate the process exiting after the transcript was written but before it acknowledged the audio-only sheet.
  const sql = postgres(testDatabase, { max: 1 });
  try {
    await sql`update source_analysis set status='processing', lease_id=${randomUUID()}, lease_until=now() - interval '1 minute',
      timestamps_ms=null where project_id=${id} and asset_id=${assetId}`;
    const retries = await Promise.all([1, 2].map(() => page.request.post(path, { data: {} })));
    for (const retry of retries) await expect(retry).toBeOK();
    await expect.poll(async () => (await (await page.request.get(path)).json()).status, { timeout: 45_000 }).toBe("ready");
    const rows = await sql`select status from source_analysis where project_id=${id} and asset_id=${assetId}`;
    expect(rows.map(row => row.status)).toEqual(["ready"]);
  } finally { await sql.end(); }
  const current = await (await page.request.get(path)).json();
  expect(current).toMatchObject({ transcriptStatus: "corrected", revision: 1 });
  expect(current.words[0].text).toBe("Reviewed");
  expect((await (await page.request.get(path + "?view=original")).json()).words).toEqual(original.words);
});
