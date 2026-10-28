# Architecture

Short overview; [AGENT_PROMPT.md](../AGENT_PROMPT.md) is the full specification.

## Flow

```
platform page ──(content script / page-world hook)──▶ adapter (pure parser)
      │ SubmissionEvent (zod-validated, sha256 of source)
      ▼
extension service worker ── outbox in chrome.storage.local (survives SW restarts)
      │ UploadSink
      ├─ LocalUploader (local mode: dedup + GitHub upload inside the extension)
      └─ BackendSink   (backend mode, once paired: POST /v1/submissions)
                          │ bearer token per install, CORS = extension origin
                          ▼
               api ── Postgres (source of truth: submissions, upload_jobs, settings,
                          │      sealed GitHub token; dedup under pg_advisory_xact_lock)
                          │ jobId = <platform>-<submissionId>, row id only
                          ▼
               Redis/BullMQ ──▶ worker ── GitHub Git Data API (blob → tree → commit → ref)
                          ▲
               reconciler (startup + interval) re-enqueues orphaned DB jobs
```

## Packages

| Package              | Role                                                                                                                | Allowed dependencies                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `packages/shared`    | Types + zod schemas, slug/path sanitizer, language map, commit-message builder, timezone-aware period math, hashing | zod only; no browser/Node APIs                   |
| `packages/core`      | Dedup engine (reservation semantics), GitHub uploader, error classification, `UploadSink` interface                 | `shared`; I/O injected (`fetch`, clock, storage) |
| `packages/extension` | MV3 extension: per-platform content scripts, service worker, React popup/options                                    | `shared`, `core`                                 |
| `packages/backend`   | Express API, BullMQ worker, reconciler, SQL migrations, CLI (`migrate`, `api`, `worker`, `pair`)                    | `shared`, `core`                                 |

Dependency direction is one-way: `extension`/`backend` → `core` → `shared`.
ESLint forbids `chrome`, `window`, `document`, `process`, `Buffer` and Node
built-in imports inside `shared` and `core`.

## Invariants

- Upload only when verdict is `ACCEPTED`, source is non-empty and its hash
  matches, and the source was fetched for that exact submission ID.
- A problem counts as uploaded only after GitHub confirms the ref update.
- Idempotency key `(platform, submissionId)`; dedup key `(userId, platform, problemKey)`.
- Source code is preserved byte-for-byte end to end (verified via SHA-256).
- Never overwrite an unrelated solution: collisions go to `solution-<submissionId>.<ext>`.
- Secrets never leave the service worker (local mode) or the backend (backend mode).

## Module boundaries in the extension

- **Page world** (injected script): only hooks network responses and posts
  shape-validated messages to the isolated world. No privileges.
- **Isolated content script**: runs the adapter, dedupes by
  `platform:submissionId`, sends `SubmissionEvent` to the service worker.
- **Service worker**: validates sender + schema, re-hashes, holds the outbox,
  talks to the sink. The only extension context that ever sees a token.
- **Popup/options**: read state and send commands; render text only.

## Backend processes

- **api** (`cli.js api`): applies migrations, serves `/healthz`, `/readyz`
  and `/v1`. Ingest runs core's dedup engine against `PgJobStore` inside a
  transaction holding the problem's advisory lock, then enqueues.
- **worker** (`cli.js worker`): claims a row (`UPLOADING`) under the same
  lock, runs core's `processJob`, stores the result. Retries move the same
  BullMQ job to delayed. The reconciler runs at start and every
  `RECONCILE_INTERVAL_MS` and re-enqueues active rows with no live job.
- **pair** (`cli.js pair`): prints a one-time, 10-minute pairing code to
  the terminal. The extension trades it for a bearer token; both are
  stored only as SHA-256 hashes.
