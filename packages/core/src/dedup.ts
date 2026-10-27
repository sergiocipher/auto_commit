import {
  describePeriod,
  isEligible,
  type Platform,
  type Settings,
  type SubmissionEvent,
} from "@cst/shared";
import { RESERVING_STATUSES, type UploadJob } from "./jobs.js";
import { assertUploadable } from "./validate.js";

/**
 * Persistence the dedup engine needs. Backends: chrome.storage (extension
 * local mode) and Postgres (backend, with pg_advisory_xact_lock).
 */
export interface DedupStore {
  /** Runs fn exclusively for one (user, platform, problemKey). */
  withProblemLock<T>(
    userId: string,
    platform: Platform,
    problemKey: string,
    fn: () => Promise<T>,
  ): Promise<T>;
  findBySubmission(platform: Platform, submissionId: string): Promise<UploadJob | undefined>;
  listByProblem(userId: string, platform: Platform, problemKey: string): Promise<UploadJob[]>;
  insert(job: UploadJob): Promise<void>;
  update(job: UploadJob): Promise<void>;
}

export type IngestDecision =
  /** New job created and reserving the slot. */
  | { decision: "queued"; job: UploadJob }
  /** New job recorded as not eligible in the current window. */
  | { decision: "skipped"; job: UploadJob }
  /** Same submission seen before; nothing new created. */
  | { decision: "existing"; job: UploadJob }
  /** Force upload revived a skipped/failed job for the same submission. */
  | { decision: "requeued"; job: UploadJob };

export interface IngestOptions {
  userId: string;
  settings: Pick<Settings, "period" | "timezone">;
  now: number;
  newId: () => string;
  /** Bypass the period window; never bypasses accepted/source/idempotency checks. */
  force?: boolean;
}

function blockingTimes(jobs: UploadJob[], exceptId?: string): number[] {
  return jobs
    .filter(
      (j) => j.id !== exceptId && (j.status === "SUCCESS" || RESERVING_STATUSES.includes(j.status)),
    )
    .map((j) => j.submittedAt);
}

/**
 * Decides whether an accepted submission should be uploaded and records the
 * decision. Serialized per problem so concurrent events cannot both pass.
 */
export async function ingestSubmission(
  store: DedupStore,
  raw: SubmissionEvent,
  opts: IngestOptions,
): Promise<IngestDecision> {
  const event = await assertUploadable(raw);
  const force = opts.force ?? false;
  return store.withProblemLock(opts.userId, event.platform, event.problemKey, async () => {
    const existing = await store.findBySubmission(event.platform, event.submissionId);
    if (existing) {
      const revivable =
        existing.status === "SKIPPED_NOT_ELIGIBLE" ||
        existing.status === "SKIPPED_DUPLICATE" ||
        existing.status === "FAILED_PERMANENT";
      if (force && revivable) {
        const job: UploadJob = {
          ...existing,
          event: existing.event ?? event,
          status: "QUEUED",
          force: true,
          attempts: 0,
          nextAttemptAt: opts.now,
          updatedAt: opts.now,
          lastError: undefined,
        };
        await store.update(job);
        return { decision: "requeued", job };
      }
      return { decision: "existing", job: existing };
    }

    const others = await store.listByProblem(opts.userId, event.platform, event.problemKey);
    const eligible =
      force ||
      isEligible(
        opts.settings.period,
        opts.settings.timezone,
        event.submittedAt,
        blockingTimes(others),
      );
    const job: UploadJob = {
      id: opts.newId(),
      userId: opts.userId,
      platform: event.platform,
      problemKey: event.problemKey,
      problemTitle: event.problemTitle,
      submissionId: event.submissionId,
      language: event.language,
      submittedAt: event.submittedAt,
      status: eligible ? "QUEUED" : "SKIPPED_NOT_ELIGIBLE",
      attempts: 0,
      force,
      createdAt: opts.now,
      updatedAt: opts.now,
      ...(eligible
        ? { nextAttemptAt: opts.now }
        : {
            lastError: `Already uploaded during this period (${describePeriod(opts.settings.period)}).`,
          }),
      event,
    };
    await store.insert(job);
    return { decision: eligible ? "queued" : "skipped", job };
  });
}

/**
 * Manual retry of a FAILED_PERMANENT or NEEDS_AUTH job. Failed jobs released
 * their reservation, so eligibility is re-checked unless the job was forced.
 */
export async function retryJob(
  store: DedupStore,
  job: UploadJob,
  opts: Omit<IngestOptions, "newId" | "force">,
): Promise<UploadJob> {
  if (job.status !== "FAILED_PERMANENT" && job.status !== "NEEDS_AUTH" && job.status !== "RETRYING")
    return job;
  return store.withProblemLock(opts.userId, job.platform, job.problemKey, async () => {
    const current = (await store.findBySubmission(job.platform, job.submissionId)) ?? job;
    if (!current.event) {
      const failed: UploadJob = {
        ...current,
        status: "FAILED_PERMANENT",
        lastError: "Source code is no longer stored; submit again.",
        updatedAt: opts.now,
      };
      await store.update(failed);
      return failed;
    }
    const others = await store.listByProblem(opts.userId, current.platform, current.problemKey);
    const eligible =
      current.force ||
      isEligible(
        opts.settings.period,
        opts.settings.timezone,
        current.submittedAt,
        blockingTimes(others, current.id),
      );
    const next: UploadJob = eligible
      ? {
          ...current,
          status: "QUEUED",
          attempts: 0,
          nextAttemptAt: opts.now,
          lastError: undefined,
          updatedAt: opts.now,
        }
      : {
          ...current,
          status: "SKIPPED_NOT_ELIGIBLE",
          lastError: `Already uploaded during this period (${describePeriod(opts.settings.period)}).`,
          updatedAt: opts.now,
        };
    await store.update(next);
    return next;
  });
}
