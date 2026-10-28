import {
  ingestSubmission,
  InvalidSubmissionError,
  isRunnable,
  processJob,
  requeueJob,
  type Clock,
  type HttpFetch,
  type KeyValueJobStore,
  type UploadJob,
} from "@cst/core";
import type { SubmissionEvent } from "@cst/shared";
import type { UploadSummary } from "./handler.js";
import type { DeliveryResult } from "./outbox.js";
import type { SettingsStore } from "./settings.js";

export const LOCAL_USER_ID = "local";

export interface LocalUploaderDeps {
  jobs: KeyValueJobStore;
  settings: SettingsStore;
  fetch: HttpFetch;
  getToken: () => Promise<string | undefined>;
  now: Clock;
  newId: () => string;
  /** Called after every job state change (popup/activity updates). */
  onJob: (job: UploadJob) => Promise<void>;
}

/**
 * Local-mode upload sink: dedup decisions and GitHub uploads run inside the
 * service worker, with jobs persisted in chrome.storage via core's
 * KeyValueJobStore. The backend sink (stage 6) replaces this.
 */
export class LocalUploader {
  private running = false;
  private runAgain = false;

  constructor(private readonly deps: LocalUploaderDeps) {}

  /** Outbox delivery: record the dedup decision; the upload runs in runDue. */
  readonly deliver = async (event: SubmissionEvent): Promise<DeliveryResult> => {
    const settings = await this.deps.settings.get();
    try {
      const { job } = await ingestSubmission(this.deps.jobs, event, {
        userId: LOCAL_USER_ID,
        settings,
        now: this.deps.now(),
        newId: this.deps.newId,
        hold: !settings.autoUpload,
      });
      return {
        kind: "accepted",
        status: job.status,
        ...(job.lastError ? { detail: job.lastError } : {}),
      };
    } catch (err) {
      if (err instanceof InvalidSubmissionError) return { kind: "rejected", error: err.message };
      throw err;
    }
  };

  /** Processes every due job once. Overlapping calls coalesce into one more pass. */
  async runDue(): Promise<void> {
    if (this.running) {
      this.runAgain = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.runAgain = false;
        for (const queued of await this.deps.jobs.listRunnable(this.deps.now())) {
          const current = await this.deps.jobs.get(queued.id);
          if (!current || !isRunnable(current, this.deps.now())) continue;
          const uploading: UploadJob = {
            ...current,
            status: "UPLOADING",
            updatedAt: this.deps.now(),
          };
          await this.deps.jobs.update(uploading);
          await this.deps.onJob(uploading);
          const settings = await this.deps.settings.get();
          const next = await processJob(uploading, {
            fetch: this.deps.fetch,
            now: this.deps.now,
            getToken: this.deps.getToken,
            settings,
          });
          await this.deps.jobs.update(next);
          await this.deps.onJob(next);
        }
      } while (this.runAgain);
    } finally {
      this.running = false;
    }
  }

  /**
   * Queues a stored job again: retry (failed / needs-auth / retrying), manual
   * upload (held), or with `force`, upload even if the period was used up.
   */
  async retry(
    platform: UploadJob["platform"],
    submissionId: string,
    options: { force?: boolean } = {},
  ): Promise<UploadJob | undefined> {
    const job = await this.deps.jobs.findBySubmission(platform, submissionId);
    if (!job) return undefined;
    const settings = await this.deps.settings.get();
    const next = await requeueJob(this.deps.jobs, job, {
      userId: LOCAL_USER_ID,
      settings,
      now: this.deps.now(),
      force: options.force ?? false,
    });
    if (next !== job) await this.deps.onJob(next);
    return next;
  }

  /** Retries every failed or needs-auth job; returns how many were queued. */
  async retryFailed(): Promise<number> {
    let queued = 0;
    for (const job of await this.deps.jobs.list()) {
      if (job.status !== "FAILED_PERMANENT" && job.status !== "NEEDS_AUTH") continue;
      const next = await this.retry(job.platform, job.submissionId);
      if (next?.status === "QUEUED") queued++;
    }
    return queued;
  }

  /** Upload history, newest first, without source code. */
  async history(): Promise<UploadSummary[]> {
    return (await this.deps.jobs.list()).map(({ event, ...rest }) => ({
      ...rest,
      sourceStored: event !== undefined,
    }));
  }

  /** After reconnecting GitHub, resume every job that was waiting for auth. */
  async resumeNeedsAuth(): Promise<void> {
    for (const job of await this.deps.jobs.list()) {
      if (job.status === "NEEDS_AUTH") await this.retry(job.platform, job.submissionId);
    }
  }

  /**
   * Jobs left UPLOADING by a killed service worker would otherwise never run
   * again; return them to QUEUED (the uploader is idempotent).
   */
  async recoverInterrupted(): Promise<void> {
    if (this.running) return;
    for (const job of await this.deps.jobs.list()) {
      if (job.status === "UPLOADING") {
        const queued: UploadJob = {
          ...job,
          status: "QUEUED",
          nextAttemptAt: this.deps.now(),
          updatedAt: this.deps.now(),
        };
        await this.deps.jobs.update(queued);
        await this.deps.onJob(queued);
      }
    }
  }

  nextWakeAt(): Promise<number | null> {
    return this.deps.jobs.nextWakeAt();
  }
}
