import { redact } from "./redact.js";
import type { HttpResponse } from "./runtime.js";

/**
 * - retryable: try again later (network, 5xx, rate limits)
 * - needs_auth: token missing/invalid/revoked; keep the job, wait for reconnect
 * - permanent: will not succeed without a configuration change
 * - conflict: branch moved under us; rebuild the commit and retry immediately
 */
export type UploadErrorKind = "retryable" | "needs_auth" | "permanent" | "conflict";

export class UploadError extends Error {
  override name = "UploadError";
  constructor(
    readonly kind: UploadErrorKind,
    message: string,
    readonly retryAfterMs?: number,
    readonly status?: number,
  ) {
    super(redact(message));
  }
}

function retryAfterMs(headers: HttpResponse["headers"], now: number): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  if (headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - now);
  }
  return undefined;
}

function githubMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === "string") return parsed.message.slice(0, 300);
  } catch {
    // not JSON
  }
  return "";
}

/** Maps a non-2xx GitHub API response to an actionable, redacted error. */
export function classifyResponse(
  res: Pick<HttpResponse, "status" | "headers">,
  body: string,
  now: number,
  context: string,
): UploadError {
  const { status } = res;
  const detail = githubMessage(body);
  const suffix = detail ? `: ${detail}` : "";
  const wait = retryAfterMs(res.headers, now);
  const rateLimited =
    status === 429 || (status === 403 && (wait !== undefined || /rate limit/i.test(detail)));

  if (rateLimited) {
    return new UploadError(
      "retryable",
      `GitHub rate limit while ${context}${suffix}`,
      wait ?? 60_000,
      status,
    );
  }
  if (status === 401) {
    return new UploadError(
      "needs_auth",
      `GitHub rejected the token while ${context}; reconnect GitHub${suffix}`,
      undefined,
      status,
    );
  }
  if (status === 403) {
    return new UploadError(
      "permanent",
      `No write access while ${context}; check the token scope and repository permissions${suffix}`,
      undefined,
      status,
    );
  }
  if (status === 404) {
    return new UploadError(
      "permanent",
      `Not found while ${context}; check the repository owner, name and branch${suffix}`,
      undefined,
      status,
    );
  }
  if (status >= 500) {
    return new UploadError(
      "retryable",
      `GitHub server error ${status} while ${context}${suffix}`,
      wait,
      status,
    );
  }
  return new UploadError(
    "permanent",
    `GitHub returned ${status} while ${context}${suffix}`,
    undefined,
    status,
  );
}

export function networkError(err: unknown, context: string): UploadError {
  const msg = err instanceof Error ? err.message : String(err);
  return new UploadError("retryable", `Network error while ${context}: ${msg}`);
}
