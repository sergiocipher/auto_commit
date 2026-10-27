const TOKEN_RE = /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g;
const AUTH_RE = /\b(Bearer|token)\s+[A-Za-z0-9._~+/-]{8,}=*/gi;
const QUERY_SECRET_RE = /((?:^|[?&\s"])(?:access_token|device_code|client_secret)=)[^&\s"]+/gi;

/**
 * Removes GitHub tokens, Authorization values, secret query parameters and
 * any explicitly known secrets from text destined for logs, stored errors or
 * the UI.
 */
export function redact(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("[REDACTED]");
  }
  return out
    .replace(TOKEN_RE, "[REDACTED]")
    .replace(AUTH_RE, "$1 [REDACTED]")
    .replace(QUERY_SECRET_RE, "$1[REDACTED]");
}
