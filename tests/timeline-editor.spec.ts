import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { signup } from "./accounts";
import { webOrigin } from "./local";

test.use({ actionTimeout: 10_000, trace: "retain-on-failure" });

const inspector = (p: Page) => p.getByRole("region", { name: "Clip inspector" });
const clips = (p: Page, track = "video") => p.getByRole("group", { name: track + " clips" }).getByRole("button");
const revision = (p: Page, n: number) => expect(p.getByRole("status")).toContainText("Revision " + n);
const button = (p: Page, name: string) => p.getByRole("button", { name, exact: true });

async function openProject(page: Page, title: string) {
  await signup(page, randomUUID() + "@cutroom.test");
  await button(page, "New project").click();
  await page.getByLabel("Project title").fill(title);
  await button(page, "Create project").click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
}

async function add(page: Page, track: string, start: number, duration: number, source = 0, linked = false) {
  const form = inspector(page);
  if (await form.getByRole("button", { name: "Add clip", exact: true }).count()) await button(page, "Add clip").click();
  await form.getByRole("combobox", { name: "Track", exact: true }).selectOption(track);
  await form.getByLabel("Timeline start").fill(String(start));
  await form.getByLabel("Duration (frames)").fill(String(duration));
  if (track === "title" || track === "caption") await form.getByLabel("Clip text").fill("First light");
  else await form.getByLabel("Source start").fill(String(source));
  if (linked) await form.getByLabel("Link to selected clip").check();
  await button(page, "Insert clip").click();
}

async function pictureAt(page: Page, frame: number, sourceSecond: number) {
  await page.getByLabel("Playhead frame").fill(String(frame));
  const video = page.getByRole("region", { name: "Project preview" }).locator("video");
  await expect.poll(async () => (await video.count()) && video.first().evaluate(v => {
    const el = v as HTMLVideoElement;
    return el.readyState >= 2 && !el.seeking ? el.currentTime : -1;
  })).toBeCloseTo(sourceSecond, 1);
  return video.first().evaluate(v => {
    const canvas = document.createElement("canvas");
    canvas.width = 64; canvas.height = 36;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(v as HTMLVideoElement, 0, 0, 64, 36);
    return canvas.toDataURL();
  });
}

test("split, undo, reopen and redo preserve the decoded source frame; a lost save response cannot duplicate the cut", async ({ page }) => {
  await openProject(page, "Lunar sequence");
  await add(page, "video", 150, 150, 360);
  await revision(page, 1);
  const before = await pictureAt(page, 210, 14);
  await inspector(page).getByLabel("Action").selectOption("split");
  await inspector(page).getByLabel("Timeline frame").fill("210");

  const attempts: string[] = [];
  await page.route("**/edits", async route => {
    attempts.push(route.request().postData()!);
    if (attempts.length === 1) {
      expect((await route.fetch()).ok()).toBe(true);
      await route.abort("failed");
    } else await route.continue();
  });
  await button(page, "Split clip").click();
  await button(page, "Retry save").click();
  await revision(page, 2);
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toBe(attempts[1]);
  await expect(clips(page)).toHaveCount(2);
  await clips(page).nth(1).click();
  await expect(inspector(page)).toContainText("Source 420–509");
  expect(await pictureAt(page, 210, 14)).toBe(before);
  await button(page, "Undo").click();
  await revision(page, 3);
  await page.reload();
  await expect(clips(page)).toHaveCount(1);
  expect(await pictureAt(page, 210, 14)).toBe(before);
  await button(page, "Redo").click();
  await revision(page, 4);
  await page.reload();
  await expect(clips(page)).toHaveCount(2);
  expect(await pictureAt(page, 210, 14)).toBe(before);
});

test("two tabs receive saved revisions, keep a stale draft intact and catch up after reconnecting", async ({ page, browser }) => {
  await openProject(page, "Across two tabs");
  const other = await browser.newContext({ baseURL: webOrigin, storageState: await page.context().storageState() });
  try {
    const second = await other.newPage();
    await second.goto(page.url());
    await revision(second, 0);
    await add(page, "title", 0, 90);
    await revision(page, 1);
    await revision(second, 1);
    await clips(second, "title").first().click();
    await inspector(second).getByLabel("Clip text").fill("My unsaved draft");
    await inspector(page).getByLabel("Clip text").fill("Earth from orbit");
    await inspector(page).getByLabel("X position").fill("103");
    await button(page, "Save properties").click();
    await revision(page, 2);
    await expect(second.getByRole("status")).toContainText("Another edit was saved");
    await expect(inspector(second).getByLabel("Clip text")).toHaveValue("My unsaved draft");
    await expect(button(second, "Save properties")).toBeDisabled();
    await button(second, "Load latest").click();
    await revision(second, 2);
    await expect(inspector(second).getByLabel("Clip text")).toHaveValue("Earth from orbit");
    await expect(second.getByRole("region", { name: "Project preview" }).getByText("Earth from orbit")).toBeVisible();

    let connections = 0;
    let resume!: () => void;
    const disconnected = new Promise<void>(resolve => { resume = resolve; });
    await second.route("**/events?*", async route => {
      if (++connections <= 2) {
        // End the stream after its acknowledged event to force Chromium's native reconnect.
        await route.fulfill({ contentType: "text/event-stream", body: "retry: 100\nid: 2\nevent: revision\ndata: 2\n\n" });
      } else {
        await disconnected;
        await route.continue();
      }
    });
    await second.reload();
    await expect.poll(() => connections).toBeGreaterThan(2);
    await button(page, "Undo").click();
    await revision(page, 3);
    resume();
    await revision(second, 3);
    await second.unroute("**/events?*");
    await clips(second, "title").first().click();
    await expect(inspector(second).getByLabel("Clip text")).toHaveValue("First light");
    await expect(inspector(second).getByLabel("X position")).toHaveValue("68");
    const caughtUp = await second.evaluate(async () => {
      const response = await fetch("/api" + location.pathname + "/events?since=3", { headers: { "Last-Event-ID": "1" } });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      try {
        while (!text.includes("id: 3\n\n")) {
          const chunk = await reader.read();
          if (chunk.done) break;
          text += decoder.decode(chunk.value, { stream: true });
        }
      } finally { await reader.cancel(); }
      return text;
    });
    expect(caughtUp).toContain("event: revision\ndata: 3\nid: 3");
    await button(second, "Redo").click();
    await revision(page, 4);
    await expect(inspector(page).getByLabel("X position")).toHaveValue("103");
  } finally { await other.close(); }
});

test("on a narrow screen, linked picture and captions ripple together, respect locks and leave music anchored", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openProject(page, "Linked cut");
  await add(page, "video", 0, 60);
  await revision(page, 1);
  await add(page, "caption", 0, 60, 0, true);
  await revision(page, 2);
  await add(page, "music", 12, 100);
  await revision(page, 3);
  await add(page, "video", 60, 30);
  await revision(page, 4);
  await button(page, "Lock caption track").click();
  await revision(page, 5);
  await clips(page).first().click();
  await inspector(page).getByLabel("Action").selectOption("ripple");
  await button(page, "Ripple delete clip").click();
  await expect(page.getByRole("status")).toContainText("Unlock the caption track");
  await expect(clips(page)).toHaveCount(2);
  await button(page, "Unlock caption track").click();
  await revision(page, 6);
  await inspector(page).getByLabel("Action").selectOption("ripple");
  await button(page, "Ripple delete clip").click();
  await revision(page, 7);
  await expect(clips(page)).toHaveCount(1);
  await expect(clips(page).first()).toHaveAccessibleName("Earthrise rushes at frame 0");
  await expect(clips(page, "caption")).toHaveCount(0);
  await expect(clips(page, "music").first()).toHaveAccessibleName("Earthrise rushes at frame 12");
  await button(page, "Undo").click();
  await revision(page, 8);
  await expect(clips(page)).toHaveCount(2);
  await expect(clips(page, "caption")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await clips(page).last().click();
  const form = inspector(page);
  await form.getByLabel("Volume").fill("0.4");
  await form.getByLabel("X position").fill("12");
  await button(page, "Save properties").click();
  await revision(page, 9);
  for (const [action, label, frame, rev] of [
    ["move", "Timeline frame", "120", 10],
    ["left", "Timeline frame", "122", 11],
    ["right", "End frame (exclusive)", "145", 12],
  ] as const) {
    await form.getByLabel("Action").selectOption(action);
    await form.getByLabel(label).fill(frame);
    await button(page, "Apply edit").click();
    await revision(page, rev);
  }
  await page.reload();
  await clips(page).last().click();
  await expect(form).toContainText("Frames 122–144 · 23 frames · Source 2–24");
  await expect(form.getByLabel("Volume")).toHaveValue("0.4");
  await expect(form.getByLabel("X position")).toHaveValue("12");
  await form.getByLabel("Action").selectOption("delete");
  await button(page, "Delete clip").click();
  await revision(page, 13);
  await expect(clips(page)).toHaveCount(1);
});
