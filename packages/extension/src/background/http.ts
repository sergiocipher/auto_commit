import type { HttpFetch } from "@cst/core";

/** Upper bound for one GitHub or backend request, headers and body included. */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * fetch with a timeout, so a hung connection cannot keep the outbox or an
 * upload waiting forever. A timeout rejects like a network error (retried).
 */
export function timedFetch(timeoutMs = REQUEST_TIMEOUT_MS): HttpFetch {
  return (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
