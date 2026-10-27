import { z } from "zod";
import {
  PlatformSchema,
  UploadStatusSchema,
  VerdictSchema,
  type SubmissionEvent,
} from "@cst/shared";
import type { KeyValueStore } from "../storage.js";
import { createSerialLock } from "../lock.js";
import { submissionKey } from "../platforms.js";
import type { VerdictObserved } from "../messages.js";
import type { UploadJob } from "@cst/core";
import type { DeliveryReport } from "./outbox.js";

export const ACTIVITY_STORAGE_KEY = "activity:v1";
export const MAX_ACTIVITY_ENTRIES = 50;

export const ActivityEntrySchema = z.object({
  key: z.string(),
  platform: PlatformSchema,
  submissionId: z.string(),
  verdict: VerdictSchema,
  rawVerdict: z.string().optional(),
  problemKey: z.string().optional(),
  problemTitle: z.string().optional(),
  language: z.string().optional(),
  /** True while the event sits in the outbox waiting for the sink. */
  queued: z.boolean(),
  /** Status reported by the sink; absent until the sink has taken the event. */
  status: UploadStatusSchema.optional(),
  detail: z.string().optional(),
  commitSha: z.string().optional(),
  filePath: z.string().optional(),
  updatedAt: z.number(),
});
export type ActivityEntry = z.infer<typeof ActivityEntrySchema>;

/**
 * Recent submissions and their upload progress, newest first, for the popup.
 * A cache only: the sink (and later the backend) holds the authoritative state.
 */
export class ActivityLog {
  private readonly lock = createSerialLock();

  constructor(private readonly store: KeyValueStore) {}

  private async load(): Promise<ActivityEntry[]> {
    const parsed = z
      .array(ActivityEntrySchema)
      .safeParse(await this.store.get(ACTIVITY_STORAGE_KEY));
    return parsed.success ? parsed.data : [];
  }

  private update(
    key: string,
    now: number,
    patch: (existing: ActivityEntry | undefined) => ActivityEntry,
  ): Promise<void> {
    return this.lock(async () => {
      const entries = await this.load();
      const idx = entries.findIndex((e) => e.key === key);
      const next = { ...patch(idx === -1 ? undefined : entries[idx]), updatedAt: now };
      if (idx !== -1) entries.splice(idx, 1);
      entries.unshift(next);
      await this.store.set(ACTIVITY_STORAGE_KEY, entries.slice(0, MAX_ACTIVITY_ENTRIES));
    });
  }

  recordVerdict(v: VerdictObserved, now: number): Promise<void> {
    const key = submissionKey(v.platform, v.submissionId);
    return this.update(key, now, (e) => ({
      queued: false,
      ...e,
      key,
      platform: v.platform,
      submissionId: v.submissionId,
      verdict: v.verdict,
      rawVerdict: v.rawVerdict ?? e?.rawVerdict,
      problemKey: v.problemKey ?? e?.problemKey,
      problemTitle: v.problemTitle ?? e?.problemTitle,
      updatedAt: now,
    }));
  }

  recordQueued(event: SubmissionEvent, now: number): Promise<void> {
    const key = submissionKey(event.platform, event.submissionId);
    return this.update(key, now, (e) => ({
      ...e,
      key,
      platform: event.platform,
      submissionId: event.submissionId,
      verdict: event.verdict,
      problemKey: event.problemKey,
      problemTitle: event.problemTitle,
      language: event.language,
      queued: true,
      detail: undefined,
      updatedAt: now,
    }));
  }

  recordDelivery(report: DeliveryReport, now: number): Promise<void> {
    const { event, result } = report;
    return this.update(report.key, now, (e) => {
      const base: ActivityEntry = {
        ...e,
        key: report.key,
        platform: event.platform,
        submissionId: event.submissionId,
        verdict: event.verdict,
        problemKey: event.problemKey,
        problemTitle: event.problemTitle,
        language: event.language,
        queued: false,
        updatedAt: now,
      };
      if (result.kind === "accepted")
        return { ...base, status: result.status, detail: result.detail };
      if (result.kind === "rejected")
        return { ...base, status: "FAILED_PERMANENT", detail: result.error };
      return { ...base, queued: true, detail: result.error };
    });
  }

  /** Mirrors an upload job's state (local uploader or, later, the backend). */
  recordJob(job: UploadJob, now: number): Promise<void> {
    const key = submissionKey(job.platform, job.submissionId);
    return this.update(key, now, (e) => ({
      ...e,
      key,
      platform: job.platform,
      submissionId: job.submissionId,
      verdict: "ACCEPTED",
      problemKey: job.problemKey,
      problemTitle: job.problemTitle,
      language: job.language,
      queued: false,
      status: job.status,
      detail: job.lastError,
      commitSha: job.commitSha,
      filePath: job.filePath,
      updatedAt: now,
    }));
  }

  list(): Promise<ActivityEntry[]> {
    return this.lock(() => this.load());
  }

  clear(): Promise<void> {
    return this.lock(() => this.store.remove(ACTIVITY_STORAGE_KEY));
  }
}
