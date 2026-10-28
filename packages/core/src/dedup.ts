import {
  describePeriod,
  isEligible,
  periodBucket,
  type Platform,
  type Settings,
  type SubmissionEvent,
  type UploadStatus,
} from "@cst/shared";
import { RESERVING_STATUSES, type UploadJob } from "./jobs.js";
import { assertUploadable, InvalidSubmissionError } from "./validate.js";

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
  /** New eligible job waiting for a manual upload (auto-upload off). */
  | { decision: "held"; job: UploadJob }
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
  /** Auto-upload is off: record an eligible submission as HELD instead of queueing it. */
  hold?: boolean;
}

/** Statuses a stored job can be queued again from (retry, manual or force upload). */
export const REQUEUEABLE_STATUSES: readonly UploadStatus[] = [
  "HELD",
  "SKIPPED_NOT_ELIGIBLE",
  "SKIPPED_DUPLICATE",
  "FAILED_PERMANENT",
  "NEEDS_AUTH",
  "RETRYING",
];

const HELD_MESSAGE = "Auto-upload is off; upload it from the extension popup.";

function notEligibleMessage(settings: Pick<Settings, "period">): string {
  return `Already uploaded during this period (${describePeriod(settings.period)}).`;
}

function reservationBucket(
  settings: Pick<Settings, "period" | "timezone">,
  submittedAt: number,
  force: boolean,
): string | undefined {
  if (force) return undefined;
  return periodBucket(settings.period, submittedAt, settings.timezone) ?? undefined;
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
        existing.status === "HELD" ||
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
          reservationBucket: undefined,
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
    const status: UploadStatus = !eligible
      ? "SKIPPED_NOT_ELIGIBLE"
      : opts.hold && !force
        ? "HELD"
        : "QUEUED";
    const job: UploadJob = {
      id: opts.newId(),
      userId: opts.userId,
      platform: event.platform,
      problemKey: event.problemKey,
      problemTitle: event.problemTitle,
      submissionId: event.submissionId,
      language: event.language,
      submittedAt: event.submittedAt,
      status,
      attempts: 0,
      force,
      createdAt: opts.now,
      updatedAt: opts.now,
      ...(status === "QUEUED"
        ? {
            nextAttemptAt: opts.now,
            reservationBucket: reservationBucket(opts.settings, event.submittedAt, force),
          }
        : {}),
      ...(status === "HELD" ? { lastError: HELD_MESSAGE } : {}),
      ...(status === "SKIPPED_NOT_ELIGIBLE"
        ? { lastError: notEligibleMessage(opts.settings) }
        : {}),
      event,
    };
    await store.insert(job);
    const decision = status === "QUEUED" ? "queued" : status === "HELD" ? "held" : "skipped";
    return { decision, job };
  });
}

/**
 * Queues a stored job again: retry after a failure, manual upload of a HELD
 * job, or force upload of a skipped one. Only SUCCESS counts toward the
 * window and failed jobs released their reservation, so eligibility is
 * re-checked unless `force` is set (or the job was forced before). The
 * stored submission goes through the accepted/source gate again either way.
 * Jobs in other states are returned unchanged.
 */
export async function requeueJob(
  store: DedupStore,
  job: UploadJob,
  opts: Omit<IngestOptions, "newId" | "hold">,
): Promise<UploadJob> {
  if (!REQUEUEABLE_STATUSES.includes(job.status)) return job;
  return store.withProblemLock(opts.userId, job.platform, job.problemKey, async () => {
    const current = (await store.findBySubmission(job.platform, job.submissionId)) ?? job;
    if (!REQUEUEABLE_STATUSES.includes(current.status)) return current;
    const fail = async (lastError: string) => {
      const failed: UploadJob = {
        ...current,
        status: "FAILED_PERMANENT",
        nextAttemptAt: undefined,
        lastError,
        updatedAt: opts.now,
      };
      await store.update(failed);
      return failed;
    };
    if (!current.event) return fail("Source code is no longer stored; submit again.");
    try {
      await assertUploadable(current.event);
    } catch (err) {
      if (err instanceof InvalidSubmissionError) return fail(err.message);
      throw err;
    }
    const force = current.force || (opts.force ?? false);
    const others = await store.listByProblem(opts.userId, current.platform, current.problemKey);
    const eligible =
      force ||
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
          force,
          attempts: 0,
          nextAttemptAt: opts.now,
          lastError: undefined,
          reservationBucket: reservationBucket(opts.settings, current.submittedAt, force),
          updatedAt: opts.now,
        }
      : {
          ...current,
          status: "SKIPPED_NOT_ELIGIBLE",
          nextAttemptAt: undefined,
          reservationBucket: undefined,
          lastError: notEligibleMessage(opts.settings),
          updatedAt: opts.now,
        };
    await store.update(next);
    return next;
  });
}
