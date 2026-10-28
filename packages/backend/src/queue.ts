import { Queue, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import type { UploadJob } from "@cst/core";

export const QUEUE_NAME = "uploads";

/** BullMQ job payload: only the row id. Source code never goes to Redis. */
export interface QueuePayload {
  jobRowId: string;
}

/**
 * Deterministic BullMQ job id, so enqueueing the same submission twice
 * collapses into one job. BullMQ forbids ":" in custom ids, hence "-"
 * (platform names contain no "-", so the id stays unambiguous).
 */
export function bullJobId(job: Pick<UploadJob, "platform" | "submissionId">): string {
  return `${job.platform}-${encodeURIComponent(job.submissionId)}`;
}

/** BullMQ requires maxRetriesPerRequest: null on worker connections. */
export function redisConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

export function createQueue(connection: ConnectionOptions, prefix = "cst"): Queue<QueuePayload> {
  return new Queue<QueuePayload>(QUEUE_NAME, { connection, prefix });
}

/**
 * Makes sure a runnable job is in the queue, due at its nextAttemptAt.
 * Idempotent: an existing waiting or active job is kept; a delayed one is
 * moved to the new due time (a manual retry should not wait out a backoff).
 */
export async function enqueue(
  queue: Queue<QueuePayload>,
  job: UploadJob,
  now: number,
): Promise<void> {
  const id = bullJobId(job);
  const delay = Math.max(0, (job.nextAttemptAt ?? now) - now);
  const existing = await queue.getJob(id);
  if (existing) {
    const state = await existing.getState();
    if (state === "delayed") {
      if (delay === 0) await existing.promote();
      else await existing.changeDelay(delay);
      return;
    }
    if (state === "waiting" || state === "active" || state === "prioritized") return;
    // completed / failed leftovers: replace them.
    await existing.remove().catch(() => undefined);
  }
  await queue.add(
    "upload",
    { jobRowId: job.id },
    { jobId: id, delay, attempts: 1, removeOnComplete: true, removeOnFail: true },
  );
}
