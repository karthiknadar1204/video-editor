import { expect, test } from "bun:test";
import { Worker } from "bullmq";
import { closeMediaQueue, enqueueMedia, getMediaQueue, getQueueEvents, mediaJobId, queueName, queueOptions, requestUpload, type MediaJob } from "../src/queue";

test("an upload queued twice while the worker is offline runs once and both requests see completion", async () => {
  const prefix = process.env.REDIS_PREFIX;
  process.env.REDIS_PREFIX = "cutroom-test-" + crypto.randomUUID();
  const upload = { kind: "upload" as const, projectId: crypto.randomUUID(), assetId: crypto.randomUUID(), attempt: crypto.randomUUID() };
  const queue = getMediaQueue();
  let worker: Worker<MediaJob> | undefined;
  try {
    await Promise.all([enqueueMedia(upload), enqueueMedia(upload)]);
    expect(await queue.getWaitingCount()).toBe(1);
    const events = getQueueEvents();
    await events.waitUntilReady();
    let deliveries = 0;
    worker = new Worker<MediaJob>(queueName, async job => {
      expect(job.data).toEqual(upload);
      expect(job.id).toBe(mediaJobId(upload));
      deliveries++;
    }, queueOptions(true));
    await requestUpload(upload);
    await worker.close();
    await requestUpload(upload);
    expect(deliveries).toBe(1);
  } finally {
    await worker?.close();
    await queue.obliterate({ force: true });
    await closeMediaQueue();
    if (prefix === undefined) delete process.env.REDIS_PREFIX;
    else process.env.REDIS_PREFIX = prefix;
  }
}, 20_000);
