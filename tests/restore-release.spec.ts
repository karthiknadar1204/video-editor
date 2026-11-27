import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { mailLink, signIn } from "./accounts";

test("an editor can reopen and export the legacy project from the restored staging backup", async ({ page, request }) => {
  test.skip(!process.env.E2E_RESTORE_DB, "Requires an isolated copy of the pre-release staging backup.");
  const email = "release-fixture@cutroom.test", password = "restored-" + randomUUID();
  await page.goto("/account?view=forgot");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("status")).toContainText("a reset link");
  await page.goto(await mailLink(request, email, "Reset your Cutroom password"));
  await page.getByLabel("New password").fill(password);
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page.getByRole("status")).toContainText("password has been changed");
  expect((await signIn(page, email, password)).ok()).toBe(true);
  await page.getByRole("link", { name: /Release rehearsal/ }).click();
  const id = page.url().split("/").pop();
  const response = await page.request.get("/api/projects/" + id);
  await expect(response).toBeOK();
  const saved = await response.json();
  expect(saved).toMatchObject({ revision: 0, title: "Release rehearsal", timeline: { width: 640, height: 360 } });
  expect(saved.timeline.clips).toEqual(expect.arrayContaining([expect.objectContaining({ id: "legacy-shot", sourceStart: 30 }), expect.objectContaining({ text: "Archive" })]));
  const link = page.getByRole("link", { name: /Download MP4/ });
  const versions = await page.request.get("/api/projects/" + id + "/exports");
  await expect(versions).toBeOK();
  const existing = (await versions.json()).items.find((version: { revision: number }) => version.revision === saved.revision);
  if (!existing) await page.getByRole("button", { name: /Export MP4/ }).click();
  await expect(link).toBeVisible({ timeout: 120_000 });
  const url = await link.getAttribute("href");
  const metadata = await page.evaluate(async src => {
    const video = document.createElement("video");
    video.src = src!;
    await new Promise<void>((resolve, reject) => { video.onloadeddata = () => resolve(); video.onerror = () => reject(Error("Could not decode restored export")); });
    return { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
  }, url);
  expect(metadata).toMatchObject({ width: 640, height: 360 });
  expect(metadata.duration).toBeCloseTo(1, 1);
});
