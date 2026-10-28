# Security checklist

Status of every item in [AGENT_PROMPT.md §11](../AGENT_PROMPT.md), with the
mechanism and the test or check that backs it. Reviewed 2026-10-28.

| Item                                                          | Status | How it is enforced                                                                                                                                                                            | Evidence                                                                                                                                                                                                    |
| ------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No token in content scripts                                   | ✅     | Tokens live only in service-worker storage (local mode) or the backend. ESLint forbids `chrome.storage`, the storage module and background imports in `src/content/**` and `src/adapters/**`. | `eslint.config.js`; rule checked by planting violations (stage 7)                                                                                                                                           |
| No token in popup state                                       | ✅     | `state/get` builds a summary without tokens or source.                                                                                                                                        | `handler.test.ts`: "never exposes the token in state", "returns state without any source code"                                                                                                              |
| No token in logs                                              | ✅     | Backend logger redacts values and drops secret-named fields; access logs omit bodies and headers.                                                                                             | `foundation.test.ts` (logger); `api.test.ts`: "never logs tokens, pairing codes or source code"                                                                                                             |
| No token in error text                                        | ✅     | `redact()` on every stored `lastError`; GitHub tokens only in the `Authorization` header.                                                                                                     | `errors.test.ts`: "redacts tokens echoed in error bodies"; `worker.test.ts`: "never stores the token in lastError"; `uploader.test.ts`: "sends the token only in the Authorization header"                  |
| No token in commits or metadata                               | ✅     | Commit message and `metadata.json` are built from submission fields only.                                                                                                                     | `uploader.test.ts`: "writes metadata without credentials"                                                                                                                                                   |
| Token encrypted at rest (AES-256-GCM, random IV, key id)      | ✅     | `Cipher` in `packages/backend/src/crypto.ts`; user id bound as associated data; old keys for rotation.                                                                                        | `foundation.test.ts` (Cipher); `db.test.ts`: "keeps the GitHub token encrypted at rest and bound to its user"                                                                                               |
| Bearer token stored hashed; constant-time compare             | ✅     | SHA-256 hashes for install tokens and pairing codes; `timingSafeEqual`.                                                                                                                       | `db.test.ts`: "redeems a pairing code once, before expiry, and stores only hashes"; `foundation.test.ts`: "hashes and compares in constant time"                                                            |
| CORS locked to the extension origin                           | ✅     | Other browser origins get 403; `EXTENSION_ORIGIN` must be a `chrome-extension://` origin.                                                                                                     | `api.test.ts`: "allows only the extension origin"                                                                                                                                                           |
| API bound to localhost by default                             | ✅     | `HOST` defaults to `127.0.0.1`; Compose publishes only the API port, on `127.0.0.1`. Postgres and Redis are not published.                                                                    | `foundation.test.ts`: "applies defaults"; `docker-compose.yml`                                                                                                                                              |
| Message validation on every boundary; unknown fields rejected | ✅     | zod `strictObject` for page↔content, content↔service worker, page↔service worker and every API body; sender checks in the service worker.                                                     | `handler.test.ts`: "rejects malformed and over-specified messages", sender checks; `codechef.adapter.test.ts`: "rejects relays with unknown fields"; `api.test.ts`: settings and submission rejection cases |
| Path traversal impossible                                     | ✅     | Slug sanitizer (`[a-z0-9-]`, NFKD folding, no leading dots, length cap) and path builder refuse `..`, absolute paths, unicode tricks and empty titles.                                        | `slug.test.ts` (`../../etc/passwd`, `/absolute/path`, fullwidth `../`, RTL override); `schemas.test.ts`: traversal in repo names                                                                            |
| Log redaction tested                                          | ✅     | See "No token in logs".                                                                                                                                                                       | `foundation.test.ts`, `api.test.ts`, `errors.test.ts`                                                                                                                                                       |
| Image contains no secrets                                     | ✅     | `.dockerignore` excludes `.env*`, keys and tests; nothing secret is passed at build time.                                                                                                     | `scripts/check-image.sh` passed on 2026-10-28 (history, config, filesystem, private keys, non-root user)                                                                                                    |
| Disconnect GitHub and clear local data work                   | ✅     | Disconnect deletes the token (and pending device flow); clear removes outbox, history and jobs (and backend data when paired).                                                                | `githubAuth.test.ts`: "disconnect deletes the stored token"; `handler.test.ts`: "clear local data also clears stored upload jobs…"; `api.test.ts`: "disconnects…", "deletes stored submissions and jobs"    |
| README documents limitations and data retention               | ✅     | README sections "Privacy and data retention" and "Limitations".                                                                                                                               | [README.md](../README.md)                                                                                                                                                                                   |

## Additional hardening

- Platform-derived strings are rendered as text: ESLint forbids
  `dangerouslySetInnerHTML`, `innerHTML`/`outerHTML` assignment,
  `insertAdjacentHTML`, `document.write`, `eval` and `new Function` in the
  extension. Links are built only from GitHub-safe names and 40-hex SHAs.
- Minimal permissions: host access to the three platforms and localhost;
  GitHub origins are optional and requested on "Connect GitHub"; no cookies,
  history or `<all_urls>`.
- Page-world hooks relay shape-checked metadata only; source code is always
  fetched by submission id and cross-checked against the judged submission.
- `/v1` replies are `Cache-Control: no-store` and `nosniff`; request bodies
  are limited to 4 MB; per-IP rate limits (pairing: 10 per 15 minutes).
- Pairing codes are one-time, expire after 10 minutes and are printed to
  the operator's terminal, never to the service log.
- Outgoing requests time out after 30 s, so a hung GitHub cannot stall the
  worker or the extension's outbox.
- Containers run as the `node` user with a read-only root filesystem and
  `no-new-privileges`.
- A pre-commit hook scans staged changes for token-like strings
  (`scripts/check-secrets.sh`); fixtures build fake tokens at runtime.

## Accepted risks

- **Local mode keeps the GitHub token in `chrome.storage.local`.** Content
  scripts could technically read that storage; ours never do, and lint
  enforces it. Page scripts cannot. `chrome.storage.session` would avoid
  this but forgets the token on every browser restart. Backend mode keeps
  the token out of the browser entirely.
- **Requests without an `Origin` header** (non-browser clients on this
  machine) are not blocked by CORS; they still need a paired bearer token.
- **Redis has no password.** It is reachable only on the Compose network
  and holds row ids only, never source code or tokens.
