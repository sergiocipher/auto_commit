import type { HttpFetch } from "@cst/core";

/** Upper bound for one GitHub request, headers and body included. */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * fetch with a timeout. Node's fetch has none of its own for an unresponsive
 * server, which would stall the single-concurrency worker. A timeout rejects
 * like a network error, so the job is retried with backoff.
 */
export function timedFetch(timeoutMs = REQUEST_TIMEOUT_MS): HttpFetch {
  return (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
