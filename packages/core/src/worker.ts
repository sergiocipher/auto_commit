import {
  buildCommitMessage,
  buildSolutionPath,
  resolveLanguage,
  UnsupportedLanguageError,
  type Settings,
} from "@cst/shared";
import { UploadError } from "./errors.js";
import { GitHubClient } from "./github/client.js";
import { uploadSolution } from "./github/uploader.js";
import type { UploadJob } from "./jobs.js";
import { redact } from "./redact.js";
import type { Clock, HttpFetch } from "./runtime.js";

export const DEFAULT_MAX_ATTEMPTS = 6;
const BASE_RETRY_MS = 10_000;
const MAX_RETRY_MS = 60 * 60_000;

/** Exponential backoff with jitter in [50%, 100%] of the capped delay. */
export function retryDelay(attempts: number, random: () => number = Math.random): number {
  const capped = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(capped * (0.5 + random() * 0.5));
}

export interface ProcessDeps {
  fetch: HttpFetch;
  now: Clock;
  random?: () => number;
  getToken(): Promise<string | undefined>;
  settings: Pick<Settings, "repo" | "uploadMetadata" | "languageExtensionOverrides">;
  maxAttempts?: number;
  /** Drop the stored source code once GitHub confirms the write (default true). */
  purgeSourceOnSuccess?: boolean;
}

/**
 * Runs one upload attempt for a job and returns its next state. The caller
 * persists the result. SUCCESS is only returned after GitHub confirmed the
 * ref update (or the identical file was already on the branch).
 */
export async function processJob(job: UploadJob, deps: ProcessDeps): Promise<UploadJob> {
  const now = deps.now();
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const token = await deps.getToken();
  const fail = (lastError: string, from: UploadJob = job): UploadJob => ({
    ...from,
    status: "FAILED_PERMANENT",
    lastError: redact(lastError, [token]),
    nextAttemptAt: undefined,
    updatedAt: now,
  });

  const event = job.event;
  if (!event) return fail("Source code is no longer stored; submit again.");
  const { repo } = deps.settings;
  if (!repo.owner || !repo.name)
    return fail("No repository configured. Choose one in settings, then retry.");

  if (!token) {
    return {
      ...job,
      status: "NEEDS_AUTH",
      lastError: "GitHub is not connected.",
      nextAttemptAt: undefined,
      updatedAt: now,
    };
  }

  let language;
  try {
    language = resolveLanguage(event.language, deps.settings.languageExtensionOverrides);
  } catch (err) {
    if (err instanceof UnsupportedLanguageError) return fail(err.message);
    throw err;
  }
  const commitMessage = buildCommitMessage({
    platform: event.platform,
    problemTitle: event.problemTitle,
    problemKey: event.problemKey,
    languageDisplay: language.display,
  });
  const base: UploadJob = {
    ...job,
    repository: `${repo.owner}/${repo.name}`,
    branch: repo.branch,
    commitMessage,
    filePath: job.filePath ?? safePath(job, language.extension),
  };

  try {
    const outcome = await uploadSolution(new GitHubClient(deps.fetch, token, deps.now), {
      repo,
      event,
      language,
      commitMessage,
      uploadMetadata: deps.settings.uploadMetadata,
      now,
    });
    const purge = deps.purgeSourceOnSuccess ?? true;
    return {
      ...base,
      status: "SUCCESS",
      filePath: outcome.filePath,
      commitSha: outcome.commitSha,
      uploadedAt: now,
      nextAttemptAt: undefined,
      lastError: outcome.kind === "committed" ? outcome.warning : undefined,
      event: purge ? undefined : event,
      updatedAt: now,
    };
  } catch (err) {
    if (!(err instanceof UploadError)) {
      return fail(err instanceof Error ? err.message : String(err), base);
    }
    const message = redact(err.message, [token]);
    if (err.kind === "needs_auth") {
      return {
        ...base,
        status: "NEEDS_AUTH",
        lastError: message,
        nextAttemptAt: undefined,
        updatedAt: now,
      };
    }
    if (err.kind === "permanent") return fail(message, base);
    // Retryable or exhausted conflict. Rate limits wait without burning an attempt.
    if (
      err.retryAfterMs !== undefined &&
      err.status !== undefined &&
      (err.status === 429 || err.status === 403)
    ) {
      return {
        ...base,
        status: "RETRYING",
        lastError: message,
        nextAttemptAt: now + err.retryAfterMs,
        updatedAt: now,
      };
    }
    const attempts = job.attempts + 1;
    if (attempts >= maxAttempts) {
      return fail(`Gave up after ${attempts} attempts: ${message}`, { ...base, attempts });
    }
    const delay = Math.max(err.retryAfterMs ?? 0, retryDelay(attempts, deps.random));
    return {
      ...base,
      status: "RETRYING",
      attempts,
      lastError: message,
      nextAttemptAt: now + delay,
      updatedAt: now,
    };
  }
}

function safePath(job: UploadJob, extension: string): string | undefined {
  if (!job.event) return undefined;
  try {
    return buildSolutionPath({
      platform: job.platform,
      problemSlug: job.event.problemSlug,
      extension,
    });
  } catch {
    return undefined;
  }
}
