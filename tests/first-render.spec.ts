import { expect, test } from "@playwright/test";

test("preview, export and download the ten-second sequence", async ({ page }, info) => {
  await page.addInitScript(() => {
    document.addEventListener("loadeddata", (event) => {
      if (event.target instanceof HTMLVideoElement) performance.mark("preview-decoded");
    }, true);
  });
  await page.goto("/");
  const preview = page.getByRole("region", { name: "Sequence preview" });
  const video = preview.locator("video");
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  const firstFrameMs = await page.evaluate(() => performance.getEntriesByName("preview-decoded")[0].startTime);
  await preview.getByRole("button", { name: "Play video" }).click();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(.3);
  await preview.getByRole("button", { name: "Pause video" }).click();
  await page.getByRole("button", { name: /Title in/ }).click();
  await preview.getByRole("button", { name: "Previous frame" }).click();
  await expect(preview.getByText("Frame 149", { exact: true })).toBeVisible();
  await expect(preview.getByText("Earthrise", { exact: true })).toBeHidden();

  async function captureFrame(frame: number) {
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.seeking)).toBe(false);
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(frame / 30, 2);
    return (await video.screenshot()).toString("base64");
  }

  const before = await captureFrame(149);
  await preview.getByRole("button", { name: "Next frame" }).click();
  await expect(preview.getByText("Frame 150", { exact: true })).toBeVisible();
  await expect(preview.getByText("Earthrise", { exact: true })).toBeVisible();
  const after = await captureFrame(150);
  await info.attach("frame-149.png", { body: Buffer.from(before, "base64"), contentType: "image/png" });
  await info.attach("frame-150.png", { body: Buffer.from(after, "base64"), contentType: "image/png" });

  const started = page.waitForResponse((r) => r.url().endsWith("/api/export") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Export MP4" }).click();
  expect((await started).status()).toBe(200);
  expect((await page.request.post("/api/export")).status()).toBe(409);
  await expect(page.getByRole("button", { name: /Rendering (?:[1-9]|[1-9]\d)%/ })).toBeVisible({ timeout: 100_000 });
  const download = page.getByRole("link", { name: "Download MP4" });
  await expect(download).toBeVisible({ timeout: 100_000 });
  const [file] = await Promise.all([page.waitForEvent("download"), download.click()]);
  expect(file.suggestedFilename()).toBe("earthrise.mp4");
  expect(await file.failure()).toBeNull();
  const range = await page.request.get("/api/export", { headers: { Range: "bytes=0-31" } });
  expect(range.status()).toBe(206);
  expect(range.headers()["content-range"]).toMatch(/^bytes 0-31\//);
  expect((await range.body()).byteLength).toBe(32);

  const media = await page.evaluate(async ({ before, after }) => {
    const bytes = await (await fetch("/api/export")).arrayBuffer();
    const native = document.createElement("video");
    native.src = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
    await new Promise((resolve, reject) => { native.onloadeddata = resolve; native.onerror = reject; });
    native.muted = true;
    await native.play();
    await new Promise((resolve) => { native.ontimeupdate = resolve; });
    native.pause();

    // Compare the title region of the actual Player screenshot with native MP4 playback.
    const differences = [];
    const titleCoverage = [];
    for (const [frame, png] of [[149, before], [150, after]] as const) {
      const shot = new Image();
      shot.src = "data:image/png;base64," + png;
      await shot.decode();
      const canvas = document.createElement("canvas");
      canvas.width = shot.width;
      canvas.height = shot.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("Canvas unavailable");
      const pixels = () => ctx.getImageData(shot.width * .04, shot.height * .55, shot.width * .30, shot.height * .15).data;
      ctx.drawImage(shot, 0, 0);
      const previewPixels = pixels();
      native.currentTime = (frame + 0.5) / 30;
      await new Promise((resolve) => { native.onseeked = resolve; });
      ctx.drawImage(native, 0, 0, shot.width, shot.height);
      const exportPixels = pixels();
      let sum = 0;
      let brightPixels = 0;
      for (let i = 0; i < exportPixels.length; i += 4) {
        if (exportPixels[i] > 190) brightPixels++;
        for (let rgb = 0; rgb < 3; rgb++) sum += Math.abs(previewPixels[i + rgb] - exportPixels[i + rgb]);
      }
      titleCoverage.push(brightPixels / (exportPixels.length / 4));
      differences.push(sum / (255 * 3 * exportPixels.length / 4));
    }

    const audio = await new OfflineAudioContext(1, 480_000, 48_000).decodeAudioData(bytes);
    const samples = audio.getChannelData(0);
    function rms(start: number, end: number) {
      const slice = samples.subarray(start * audio.sampleRate, end * audio.sampleRate);
      return Math.sqrt(slice.reduce((sum, value) => sum + value * value, 0) / slice.length);
    }
    URL.revokeObjectURL(native.src);
    return {
      duration: native.duration, width: native.videoWidth, height: native.videoHeight, differences, titleCoverage,
      firstSpeech: rms(2, 3), pause: rms(6.5, 7.7), lastSpeech: rms(9, 9.6),
    };
  }, { before, after });

  const result = JSON.stringify({ firstFrameMs, ...media }, null, 2);
  console.info(result);
  await info.attach("render-check.json", { body: result, contentType: "application/json" });
  expect(media).toMatchObject({ width: 1280, height: 720 });
  expect(Math.abs(media.duration - 10)).toBeLessThan(1 / 30);
  // Allow 5% mean channel error for display scaling and H.264 compression.
  for (const difference of media.differences) expect(difference).toBeLessThan(.05);
  expect(media.titleCoverage[0]).toBeLessThan(.01);
  expect(media.titleCoverage[1]).toBeGreaterThan(.10);
  expect(media.firstSpeech).toBeGreaterThan(.01);
  expect(media.pause).toBeLessThan(.001);
  expect(media.lastSpeech).toBeGreaterThan(.01);
});
