import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { mediaClip, projectSnapshot, rushes } from "../packages/timeline/src/model";
import { signup } from "./accounts";

test("drag and trim preview locally, snap on release, and remain editable from the keyboard after reopening", async ({ page }) => {
  await signup(page, randomUUID() + "@cutroom.test");
  const project = await page.request.post("/api/projects", { data: { title: "Gesture edit", format: "landscape" } });
  expect(project.status()).toBe(201);
  const path = "/projects/" + (await project.json()).id;
  const snapshot = async () => projectSnapshot.parse(await (await page.request.get("/api" + path)).json());
  const add = await page.request.post("/api" + path + "/edits", { data: {
    kind: "edit", requestId: randomUUID(), expectedRevision: 0, operations: [
      { type: "add", clip: mediaClip("one", rushes.id, 0, 60) },
      { type: "add", clip: mediaClip("two", rushes.id, 120, 30) },
    ],
  } });
  expect(add.ok()).toBe(true);
  await page.goto(path);
  const panel = page.getByRole("region", { name: "Timeline", exact: true });
  const lane = panel.getByRole("group", { name: "video clips" });
  const first = lane.getByRole("button").first(), second = lane.getByRole("button").last();
  const rev = (n: number) => expect(page.getByRole("status")).toContainText("Revision " + n);
  await expect(first).toBeEnabled();
  await first.scrollIntoViewIfNeeded();
  const one = await first.boundingBox(), two = await second.boundingBox();
  if (!one || !two) throw new Error("Clip blocks must be visible to edit.");
  const x = one.x + one.width / 2, y = one.y + one.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  // End the drag two pixels shy of the next clip; snapping closes the gap.
  await page.mouse.move(x + two.x - (one.x + one.width) - 2, y, { steps: 7 });
  await expect(first).toHaveAccessibleName("Earthrise rushes at frame 60");
  expect((await snapshot()).revision).toBe(1);
  await page.mouse.up();
  await rev(2);

  await panel.getByRole("button", { name: "Zoom in timeline" }).click();
  await expect(panel.getByRole("button", { name: "Fit timeline" })).toHaveText("2×");
  await panel.getByRole("button", { name: "Fit timeline" }).click();
  const handle = first.getByTitle("Trim start");
  const edge = await handle.boundingBox();
  if (!edge) throw new Error("The selected clip needs a trim handle.");
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 + one.width / 3, edge.y + edge.height / 2, { steps: 5 });
  await expect(first).toHaveAccessibleName("Earthrise rushes at frame 80");
  expect((await snapshot()).revision).toBe(2);
  await page.mouse.up();
  await rev(3);
  expect((await snapshot()).timeline.clips[0]).toMatchObject({ start: 80, duration: 40, sourceStart: 20 });

  await first.focus();
  await page.keyboard.press("ArrowLeft");
  await rev(4);
  await first.focus();
  await page.keyboard.press("Shift+ArrowLeft");
  await rev(5);
  await first.focus();
  await page.keyboard.press("Enter");
  const inspector = page.getByRole("region", { name: "Clip inspector" });
  await inspector.getByLabel("Canvas fit").selectOption("contain");
  await inspector.getByLabel("Rotation").selectOption("90");
  await inspector.getByRole("button", { name: "Save properties" }).click();
  await rev(6);
  await page.reload();
  const saved = (await snapshot()).timeline.clips[0];
  expect(saved).toMatchObject({ start: 79, duration: 39, sourceStart: 20, rotation: 90, fit: "contain" });
  await first.focus();
  await page.keyboard.press("Enter");
  await expect(inspector.getByLabel("Rotation")).toHaveValue("90");
  await expect(page.getByRole("region", { name: "Project preview" }).locator("video").first()).toHaveCSS("object-fit", "contain");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await rev(7);
  await expect(inspector.getByLabel("Rotation")).toHaveValue("0");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await rev(8);
  await expect(inspector.getByLabel("Rotation")).toHaveValue("90");

  await inspector.getByRole("button", { name: "Add clip", exact: true }).click();
  await inspector.getByRole("combobox", { name: "Track", exact: true }).selectOption("title");
  await inspector.getByLabel("Clip text").fill("In orbit");
  await inspector.getByRole("button", { name: "Insert clip" }).click();
  await rev(9);
  await inspector.getByLabel("Font size").fill("96");
  await inspector.getByRole("button", { name: "Save properties" }).click();
  await rev(10);
  await panel.getByRole("group", { name: "title clips" }).getByRole("button").press("Enter");
  const painted = page.getByRole("region", { name: "Project preview" }).getByText("In orbit", { exact: true });
  await expect(painted).toHaveCSS("font-size", "96px");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await rev(11);
  await expect(painted).toHaveCSS("font-size", "76px");
});
