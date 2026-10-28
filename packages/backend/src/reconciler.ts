import type { Queue } from "bullmq";
import type { PgJobStore } from "./db/jobStore.js";
import type { Logger } from "./logger.js";
import { bullJobId, enqueue, type QueuePayload } from "./queue.js";

const LIVE_STATES = new Set(["waiting", "delayed", "active", "prioritized", "waiting-children"]);

/**
 * Postgres is authoritative. Re-enqueues every QUEUED / RETRYING /
 * UPLOADING row that has no live BullMQ job (Redis lost its data, a crash
 * between the DB write and the enqueue, or a worker killed mid-upload).
 * Returns how many rows were re-enqueued.
 */
export async function reconcile(
  store: PgJobStore,
  queue: Queue<QueuePayload>,
  now: number,
  log: Logger,
): Promise<number> {
  let requeued = 0;
  for (const job of await store.listActive()) {
    const existing = await queue.getJob(bullJobId(job));
    const state = existing ? await existing.getState() : "missing";
    if (LIVE_STATES.has(state)) continue;
    // An UPLOADING row is re-run right away; runUpload re-claims it.
    await enqueue(queue, job.status === "UPLOADING" ? { ...job, nextAttemptAt: now } : job, now);
    requeued++;
    log.info("reconciler re-enqueued job", {
      jobId: job.id,
      status: job.status,
      queueState: state,
    });
  }
  return requeued;
}
