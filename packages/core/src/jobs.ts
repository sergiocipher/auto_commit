import { z } from "zod";
import {
  PlatformSchema,
  SubmissionEventSchema,
  UploadStatusSchema,
  type UploadRecord,
  type UploadStatus,
} from "@cst/shared";

export const UploadJobSchema = z.strictObject({
  id: z.string().min(1),
  userId: z.string().min(1),
  platform: PlatformSchema,
  problemKey: z.string().min(1),
  problemTitle: z.string(),
  submissionId: z.string().min(1),
  language: z.string().min(1),
  submittedAt: z.number(),
  status: UploadStatusSchema,
  attempts: z.number().int().nonnegative(),
  force: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  nextAttemptAt: z.number().optional(),
  repository: z.string().optional(),
  branch: z.string().optional(),
  filePath: z.string().optional(),
  commitMessage: z.string().optional(),
  commitSha: z.string().optional(),
  uploadedAt: z.number().optional(),
  lastError: z.string().optional(),
  /** Held until SUCCESS (then purged unless configured otherwise). */
  event: SubmissionEventSchema.optional(),
});
export type UploadJob = z.infer<typeof UploadJobSchema>;

/** Statuses that hold the problem's slot for the window (the reservation). */
export const RESERVING_STATUSES: readonly UploadStatus[] = [
  "RECEIVED",
  "QUEUED",
  "UPLOADING",
  "RETRYING",
  "NEEDS_AUTH",
];

/** Statuses the worker should pick up when due. */
export const RUNNABLE_STATUSES: readonly UploadStatus[] = ["QUEUED", "RETRYING"];

export function isRunnable(job: UploadJob, now: number): boolean {
  return RUNNABLE_STATUSES.includes(job.status) && (job.nextAttemptAt ?? 0) <= now;
}

export function toUploadRecord(job: UploadJob): UploadRecord {
  return {
    id: job.id,
    userId: job.userId,
    platform: job.platform,
    problemKey: job.problemKey,
    submissionId: job.submissionId,
    language: job.language,
    repository: job.repository ?? "",
    branch: job.branch ?? "",
    filePath: job.filePath ?? "",
    commitMessage: job.commitMessage ?? "",
    status: job.status,
    attempts: job.attempts,
    createdAt: job.createdAt,
    ...(job.commitSha ? { commitSha: job.commitSha } : {}),
    ...(job.lastError ? { lastError: job.lastError } : {}),
    ...(job.uploadedAt ? { uploadedAt: job.uploadedAt } : {}),
  };
}
