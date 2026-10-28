import { randomUUID } from "node:crypto";
import { UploadJobSchema, type DedupStore, type UploadJob } from "@cst/core";
import type { Platform, SubmissionEvent } from "@cst/shared";
import type { Db } from "./db.js";

const SELECT = `
  SELECT j.*, s.problem_slug, s.problem_id, s.problem_url, s.language_normalized, s.verdict,
         s.source_sha256, s.detected_at, s.contest
  FROM upload_jobs j JOIN submissions s ON s.id = j.submission_row_id`;

type Row = Record<string, unknown>;

/** Copies only non-null values, so optional fields stay absent rather than null. */
function present<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== null && v !== undefined),
  ) as Partial<T>;
}

function toJob(r: Row): UploadJob {
  const event: SubmissionEvent | undefined =
    r.source_code === null
      ? undefined
      : ({
          platform: r.platform,
          problemKey: r.problem_key,
          problemSlug: r.problem_slug,
          problemTitle: r.problem_title,
          problemUrl: r.problem_url,
          submissionId: r.submission_id,
          language: r.language,
          sourceCode: r.source_code,
          sourceSha256: r.source_sha256,
          verdict: r.verdict,
          submittedAt: r.submitted_at,
          detectedAt: r.detected_at,
          ...present({
            problemId: r.problem_id,
            languageNormalized: r.language_normalized,
            contest: r.contest,
          }),
        } as SubmissionEvent);
  return UploadJobSchema.parse({
    id: r.id,
    userId: r.user_id,
    platform: r.platform,
    problemKey: r.problem_key,
    problemTitle: r.problem_title,
    submissionId: r.submission_id,
    language: r.language,
    submittedAt: r.submitted_at,
    status: r.status,
    attempts: r.attempts,
    force: r.force,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...present({
      nextAttemptAt: r.next_attempt_at,
      repository: r.repository,
      branch: r.branch,
      filePath: r.file_path,
      commitMessage: r.commit_message,
      commitSha: r.commit_sha,
      uploadedAt: r.uploaded_at,
      lastError: r.last_error,
      reservationBucket: r.reservation_bucket,
      event,
    }),
  });
}

/** The mutable job columns, in a fixed order for INSERT/UPDATE. */
function jobColumns(job: UploadJob): unknown[] {
  return [
    job.status,
    job.attempts,
    job.force,
    job.nextAttemptAt ?? null,
    job.repository ?? null,
    job.branch ?? null,
    job.filePath ?? null,
    job.commitMessage ?? null,
    job.commitSha ?? null,
    job.uploadedAt ?? null,
    job.lastError ?? null,
    job.event?.sourceCode ?? null,
    job.reservationBucket ?? null,
    job.updatedAt,
  ];
}

/**
 * Postgres-backed DedupStore. Postgres is the source of truth: the problem
 * lock is a transaction-scoped advisory lock, and unique constraints back
 * up idempotency (platform, submission_id) and reservations.
 */
export class PgJobStore implements DedupStore {
  constructor(private readonly db: Db) {}

  withProblemLock<T>(
    userId: string,
    platform: Platform,
    problemKey: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async () => {
      await this.db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        JSON.stringify([userId, platform, problemKey]),
      ]);
      return fn();
    });
  }

  async findBySubmission(platform: Platform, submissionId: string): Promise<UploadJob | undefined> {
    const { rows } = await this.db.query(
      `${SELECT} WHERE j.platform = $1 AND j.submission_id = $2`,
      [platform, submissionId],
    );
    return rows[0] ? toJob(rows[0]) : undefined;
  }

  async listByProblem(
    userId: string,
    platform: Platform,
    problemKey: string,
  ): Promise<UploadJob[]> {
    const { rows } = await this.db.query(
      `${SELECT} WHERE j.user_id = $1 AND j.platform = $2 AND j.problem_key = $3`,
      [userId, platform, problemKey],
    );
    return rows.map(toJob);
  }

  insert(job: UploadJob): Promise<void> {
    const e = job.event;
    if (!e) return Promise.reject(new Error("a new job needs its submission"));
    return this.db.transaction(async () => {
      const submissionRow = randomUUID();
      await this.db.query(
        `INSERT INTO submissions (id, user_id, platform, submission_id, problem_key, problem_slug,
           problem_id, problem_title, problem_url, language, language_normalized, verdict,
           source_sha256, submitted_at, detected_at, contest)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          submissionRow,
          job.userId,
          e.platform,
          e.submissionId,
          e.problemKey,
          e.problemSlug,
          e.problemId ?? null,
          e.problemTitle,
          e.problemUrl,
          e.language,
          e.languageNormalized ?? null,
          e.verdict,
          e.sourceSha256,
          e.submittedAt,
          e.detectedAt,
          e.contest ? JSON.stringify(e.contest) : null,
        ],
      );
      await this.db.query(
        `INSERT INTO upload_jobs (id, user_id, submission_row_id, platform, submission_id,
           problem_key, problem_title, language, submitted_at, created_at,
           status, attempts, force, next_attempt_at, repository, branch, file_path, commit_message,
           commit_sha, uploaded_at, last_error, source_code, reservation_bucket, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
        [
          job.id,
          job.userId,
          submissionRow,
          job.platform,
          job.submissionId,
          job.problemKey,
          job.problemTitle,
          job.language,
          job.submittedAt,
          job.createdAt,
          ...jobColumns(job),
        ],
      );
    });
  }

  async update(job: UploadJob): Promise<void> {
    const { rowCount } = await this.db.query(
      `UPDATE upload_jobs SET status=$2, attempts=$3, force=$4, next_attempt_at=$5, repository=$6,
         branch=$7, file_path=$8, commit_message=$9, commit_sha=$10, uploaded_at=$11,
         last_error=$12, source_code=$13, reservation_bucket=$14, updated_at=$15
       WHERE id = $1`,
      [job.id, ...jobColumns(job)],
    );
    if (rowCount === 0) throw new Error("job not found");
  }

  async get(id: string): Promise<UploadJob | undefined> {
    const { rows } = await this.db.query(`${SELECT} WHERE j.id = $1`, [id]);
    return rows[0] ? toJob(rows[0]) : undefined;
  }

  /** A user's jobs, newest first. */
  async listForUser(userId: string, limit = 100): Promise<UploadJob[]> {
    const { rows } = await this.db.query(
      `${SELECT} WHERE j.user_id = $1 ORDER BY j.created_at DESC, j.id LIMIT $2`,
      [userId, limit],
    );
    return rows.map(toJob);
  }

  async countSuccess(userId: string): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM upload_jobs WHERE user_id = $1 AND status = 'SUCCESS'",
      [userId],
    );
    return rows[0]?.n ?? 0;
  }

  /** Jobs the queue should hold (for the reconciler). */
  async listActive(): Promise<UploadJob[]> {
    const { rows } = await this.db.query(
      `${SELECT} WHERE j.status IN ('QUEUED', 'UPLOADING', 'RETRYING') ORDER BY j.created_at`,
    );
    return rows.map(toJob);
  }

  async listByStatus(userId: string, statuses: readonly string[]): Promise<UploadJob[]> {
    const { rows } = await this.db.query(`${SELECT} WHERE j.user_id = $1 AND j.status = ANY($2)`, [
      userId,
      statuses,
    ]);
    return rows.map(toJob);
  }

  /** Deletes every submission and job of a user (DELETE /v1/data). */
  async deleteAllForUser(userId: string): Promise<void> {
    await this.db.query("DELETE FROM submissions WHERE user_id = $1", [userId]);
  }
}
