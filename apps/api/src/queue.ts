import { createHash } from "node:crypto";
import { Queue, QueueEvents } from "bullmq";
import { z } from "zod";

const projectId = z.uuid();
const assetId = z.string().min(1);
export const mediaJob = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("upload"), projectId, assetId, attempt: z.uuid() }),
  z.object({ kind: z.literal("analysis"), projectId, assetId }),
  z.object({ kind: z.literal("frame"), jobId: z.uuid() }),
  z.object({ kind: z.literal("candidate"), projectId, reviewId: z.uuid(), revision: z.int().nonnegative(), frame: z.int().nonnegative() }),
  z.object({ kind: z.literal("export"), exportId: z.uuid(), attempt: z.int().positive() }),
  z.object({ kind: z.literal("sample"), release: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.object({ kind: z.literal("maintenance") }),
]);
export type MediaJob = z.infer<typeof mediaJob>;
export const queueName = "media";

export function queueOptions(blocking = false) {
  const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  if (!/^rediss?:\/\//.test(url)) throw new Error("REDIS_URL must be a Redis TCP connection URL.");
  return {
    prefix: process.env.REDIS_PREFIX ?? "cutroom",
    connection: { url, maxRetriesPerRequest: blocking ? null : 1, connectTimeout: 5_000 },
  };
}

let queue: Queue<MediaJob> | undefined;
let events: QueueEvents | undefined;

export function getMediaQueue() {
  if (!queue) {
    queue = new Queue<MediaJob>(queueName, { ...queueOptions(), defaultJobOptions: {
      attempts: 3, backoff: { type: "exponential", delay: 2_000 }, removeOnComplete: true, removeOnFail: true,
    } });
    queue.on("error", () => console.error("Media queue connection interrupted."));
  }
  return queue;
}

export function getQueueEvents() {
  if (!events) {
    events = new QueueEvents(queueName, queueOptions(true));
    events.on("error", () => console.error("Media queue events connection interrupted."));
  }
  return events;
}

export function mediaJobId(input: MediaJob) {
  const data = mediaJob.parse(input);
  return data.kind + "-" + createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

export async function enqueueMedia(data: MediaJob) {
  const interactive = data.kind === "upload" || data.kind === "candidate";
  const job = getMediaQueue().add(data.kind, data, {
    jobId: mediaJobId(data),
    // An HTTP waiter can subscribe just after a fast worker finishes.
    ...(interactive && { removeOnComplete: { age: 120, count: 100 }, removeOnFail: true }),
  });
  // Redis may reconnect indefinitely. The durable request can be recovered after the API returns.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([job, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Media queue unavailable.")), 8_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function sendToWorker(data: MediaJob) {
  const job = await enqueueMedia(data);
  await job.waitUntilFinished(getQueueEvents(), 180_000);
}

export const requestCandidateFrame = (input: Omit<Extract<MediaJob, { kind: "candidate" }>, "kind">) =>
  sendToWorker({ kind: "candidate", ...input });
export const requestUpload = (input: Omit<Extract<MediaJob, { kind: "upload" }>, "kind">) =>
  sendToWorker({ kind: "upload", ...input });

export async function closeMediaQueue() {
  await Promise.all([queue?.close(), events?.close()]);
}
