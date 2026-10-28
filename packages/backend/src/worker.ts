import { DelayedError, Worker, type ConnectionOptions, type Job } from "bullmq";
import { processJob, RUNNABLE_STATUSES, type HttpFetch, type UploadJob } from "@cst/core";
import type { PgJobStore } from "./db/jobStore.js";
import type { SettingsRepo } from "./db/repos.js";
import type { Logger } from "./logger.js";
import { QUEUE_NAME, type QueuePayload } from "./queue.js";

export interface UploadRunnerDeps {
  store: PgJobStore;
  settings: SettingsRepo;
  /** The user's GitHub token, or undefined when not connected / unreadable. */
  getToken: (userId: string) => Promise<string | undefined>;
  fetch: HttpFetch;
  now: () => number;
  maxAttempts: number;
  purgeSourceOnSuccess: boolean;
  log: Logger;
  random?: () => number;
}

export type RunOutcome =
  | { kind: "done"; job: UploadJob }
  /** Not due yet (or rescheduled): run again at `at`. */
  | { kind: "later"; at: number; job: UploadJob }
  | { kind: "skipped"; reason: string };

/**
 * One upload attempt for a job row. The row is claimed (set UPLOADING)
 * under the problem lock, uploaded outside any transaction, and the result
 * persisted. A row found UPLOADING was left by a crashed attempt; BullMQ
 * runs one instance per job id, so it is safe to claim again (the uploader
 * is idempotent).
 */
export async function runUpload(jobRowId: string, deps: UploadRunnerDeps): Promise<RunOutcome> {
  const peek = await deps.store.get(jobRowId);
  if (!peek) return { kind: "skipped", reason: "job row no longer exists" };
  const claimed = await deps.store.withProblemLock(
    peek.userId,
    peek.platform,
    peek.problemKey,
    async () => {
      const job = await deps.store.get(jobRowId);
      if (!job) return { kind: "skipped" as const, reason: "job row no longer exists" };
      const now = deps.now();
      if (job.status !== "UPLOADING" && !RUNNABLE_STATUSES.includes(job.status))
        return { kind: "skipped" as const, reason: `status is ${job.status}` };
      if (job.status !== "UPLOADING" && (job.nextAttemptAt ?? 0) > now)
        return { kind: "later" as const, at: job.nextAttemptAt!, job };
      const uploading: UploadJob = { ...job, status: "UPLOADING", updatedAt: now };
      await deps.store.update(uploading);
      return { kind: "claimed" as const, job: uploading };
    },
  );
  if (claimed.kind !== "claimed") return claimed;

  const settings = await deps.settings.get(claimed.job.userId);
  const next = await processJob(claimed.job, {
    fetch: deps.fetch,
    now: deps.now,
    random: deps.random,
    getToken: () => deps.getToken(claimed.job.userId),
    settings,
    maxAttempts: deps.maxAttempts,
    purgeSourceOnSuccess: deps.purgeSourceOnSuccess,
  });
  await deps.store.update(next);
  deps.log.info("upload attempt finished", {
    jobId: next.id,
    platform: next.platform,
    problemKey: next.problemKey,
    status: next.status,
    attempts: next.attempts,
    ...(next.lastError ? { lastError: next.lastError } : {}),
  });
  if (next.status === "RETRYING" && next.nextAttemptAt !== undefined)
    return { kind: "later", at: next.nextAttemptAt, job: next };
  return { kind: "done", job: next };
}

/** BullMQ processor: delays the same job for retries instead of creating new ones. */
export function createProcessor(deps: UploadRunnerDeps) {
  return async (job: Job<QueuePayload>, token?: string): Promise<void> => {
    const outcome = await runUpload(job.data.jobRowId, deps);
    if (outcome.kind === "later") {
      await job.moveToDelayed(Math.max(outcome.at, deps.now() + 1), token);
      throw new DelayedError();
    }
    if (outcome.kind === "skipped") deps.log.debug("queue job skipped", { reason: outcome.reason });
  };
}

export function createUploadWorker(
  connection: ConnectionOptions,
  deps: UploadRunnerDeps,
  opts: { prefix?: string; concurrency?: number } = {},
): Worker<QueuePayload> {
  const worker = new Worker<QueuePayload>(QUEUE_NAME, createProcessor(deps), {
    connection,
    prefix: opts.prefix ?? "cst",
    concurrency: opts.concurrency ?? 1,
    // Stalled-job detection is on by default; a stalled job is re-delivered
    // and runUpload re-claims its UPLOADING row.
    maxStalledCount: 5,
  });
  worker.on("failed", (job, err) =>
    deps.log.error("queue job failed", { bullJobId: job?.id, err }),
  );
  worker.on("error", (err) => deps.log.error("worker error", { err }));
  return worker;
}
