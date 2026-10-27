# Decisions

Format: date — decision — reason — alternatives considered.

## 2026-10-27 — Workspace packages export TypeScript source

`shared`/`core` export `src/index.ts` directly. Vite bundles them into the
extension; the backend will be bundled too (Stage 6). Avoids a separate build
step and stale `dist/` during development. Alternative: project references
with `tsc -b` emitting per-package `dist` (more moving parts, no benefit for a
private monorepo).

## 2026-10-27 — No date library; `Intl` for timezone math

Period windows use `Intl.DateTimeFormat` with the user's IANA zone. Calendar
policies compare **bucket ids** derived from the local calendar date of each
instant (`day:2024-03-10`, `week1:2024-02-26`, `month:2024-02`), which is
correct across DST without computing offsets. Window _bounds_ (used for
query narrowing and "resets at" display only) are found by binary search for
the first instant of the local date, which also handles zones whose midnight
is skipped (e.g. America/Santiago). Alternatives: Luxon/date-fns-tz (extra
dependency in the extension bundle for little gain).

## 2026-10-27 — Rolling windows follow the spec formula literally

`rolling_24h`/`custom_hours` block when `submittedAt - lastSuccess.submittedAt
< window`. A late-arriving older submission (negative difference) is therefore
blocked too, which is the conservative choice.

## 2026-10-27 — Problem slug rules

- LeetCode: `titleSlug` is already unique → folder is the sanitized key.
- Codeforces / CodeChef: titles repeat across contests → `<key>-<title>`
  (e.g. `4a-watermelon`, `flow001-add-two-numbers`).
- Empty/unusable title → sanitized key; unusable key → error (no upload).
  Slugs are NFKD-folded to ASCII, `[a-z0-9-]`, max 80 chars. Dots and slashes
  can never survive, so traversal is impossible; paths are additionally
  asserted to be relative, normalized and under `data/`.

## 2026-10-27 — Commit message disambiguation rule

`feat(solutions): add <Platform> - <Problem> (<Language>)`. The problem key
prefixes the title for Codeforces and CodeChef always (titles are not unique
there, and users identify problems by key), and for LeetCode only when the
title is missing (`two-sum Unknown Problem`). Control/format characters are
stripped, whitespace collapsed, and the title is truncated with `...` so the
line is ≤ 100 chars when possible (title keeps at least 12 chars).

## 2026-10-27 — Unknown languages fail loudly

The language map throws `UnsupportedLanguageError` (message points to the
settings override) instead of writing `.txt`. Overrides are keyed by the
lowercased raw platform string. Rules are ordered so that TypeScript/
JavaScript precede Java, Kotlin precedes Java, and C++/C# precede C.

## 2026-10-27 — Same problem, different language in the same window

Skipped by default (the dedup key ignores language); force upload is
available. Files never overwrite each other because each language has its own
extension, and collisions fall back to `solution-<submissionId>.<ext>`.

## 2026-10-27 — Fixtures are synthetic

From this environment leetcode.com and codeforces.com return HTTP 403 to
non-browser clients and no logged-in session is available, so payloads cannot
be recorded. Fixtures are hand-built from documented/observed payload shapes,
marked `"_synthetic": true` (or a header comment for HTML) and contain no
personal data. All adapters remain `implemented, unverified` until a manual
E2E run (docs/MANUAL_E2E.md).

## 2026-10-27 — Token location in local mode (Stages 2–5)

Before the backend exists, the GitHub token obtained via device flow is held
in `chrome.storage.local` and read **only** by the service worker; content
scripts and the popup never receive it. Once backend mode ships (Stage 6),
the token moves to the backend (encrypted at rest) and local mode becomes an
explicit opt-in documented as less secure.

## 2026-10-27 — Secret scanning in hooks

`scripts/check-secrets.sh` greps the staged diff for GitHub token prefixes,
private-key headers and a non-empty `APP_ENCRYPTION_KEY=` assignment; it runs
in `pre-commit` and supports `--all` for the tracked tree.

## 2026-10-27 — Extension build: plain Vite, no CRX plugin

One Vite build produces the popup, options page and the service worker
(declared `"type": "module"`, so shared chunks are fine there). Content
scripts cannot be ES modules; they will get separate single-file IIFE builds
when the first adapter lands (stage 2). Alternative: `@crxjs/vite-plugin`
(handles this automatically, but adds a dependency whose Vite 8 support was
unverified).

## 2026-10-27 — Real-browser smoke test via raw CDP

`packages/extension/scripts/smoke.mjs` launches Chrome for Testing /
Chromium with `--load-extension`, waits for the service worker target and
drives the popup through the DevTools protocol using Node's built-in
WebSocket (no Puppeteer/Playwright dependency). Branded Google Chrome
ignores `--load-extension`, so `CHROME_PATH` must point at a Chrome for
Testing or Chromium binary.

## 2026-10-27 — Outbox semantics

- Only `ACCEPTED`, hash-verified events with a safe slug enter the outbox.
- Transient delivery failures retry indefinitely with exponential backoff
  (5 s doubling, capped at 30 min, 50–100 % jitter); `Retry-After` hints win
  when longer. "Bounded" refers to the delay, so a pending upload is never
  dropped after N attempts.
- A full outbox (200 items) refuses new events with an error rather than
  evicting pending ones.
- A bounded "seen" list (2,000 keys) suppresses re-emitted submissions even
  after delivery; the authoritative dedup lives in the sink/backend.
- Wake-ups use `chrome.alarms` (30 s minimum), and every service-worker
  start drains whatever is due, so restarts lose nothing.

## 2026-10-27 — Message trust model

The service worker accepts messages only from this extension's own pages
(`chrome-extension://<id>/…`) or from top-frame content scripts on the exact
platform hosts (`https://leetcode.com`, `https://codeforces.com`,
`https://www.codechef.com`/`codechef.com`). Content and page message sets
are disjoint, all schemas are strict (unknown fields rejected), an event's
platform must match the sending page, and the source hash is recomputed.
Errors returned to callers are fixed strings, never payload fragments.

## 2026-10-27 — "Clear local data" keeps settings

Clearing removes the outbox, the seen cache and the activity history.
Settings are kept so the user does not have to reconfigure; resetting
settings can be added later if wanted.

## 2026-10-27 — Host permissions for the local backend

`http://127.0.0.1/*` and `http://localhost/*` (match patterns ignore the
port) are declared now so the backend sink needs no permission change in
stage 6. No `<all_urls>`, cookies, tabs or history permissions.

## 2026-10-27 — Core upload pipeline shared by extension and backend

`packages/core` holds the dedup engine (`ingestSubmission`, `retryJob`), the
job processor (`processJob`), the Git Data API uploader, the device-flow
client and error classification. They depend only on injected `fetch`,
clock and a `DedupStore`. The extension uses `KeyValueJobStore` over
chrome.storage; the backend will implement `DedupStore` with Postgres and
`pg_advisory_xact_lock`. Both get identical decisions.

## 2026-10-27 — Upload algorithm details

- Existing files are found via the Contents API **directory listing** at the
  exact head commit (read-only use; writes stay on the Git Data API). Blob
  SHAs are compared with a locally computed git blob SHA-1, so identical
  content needs no download.
- After creating the blob, its SHA returned by GitHub must equal the local
  one; otherwise the upload aborts (proves GitHub stored our exact bytes).
- Identical content at the default or suffixed path → SUCCESS without a
  commit, recording the last commit that touched the file.
- Default taken by different content → `solution-<submissionId>.<ext>`; if
  that also exists with different content → permanent error (never
  overwrite).
- Ref update uses `force: false`; 409/422 → rebuild from the new head, at
  most 3 retries, then a retryable "conflict" error.
- `metadata.json` (`schemaVersion: 1`) keeps unknown/user fields, keys
  solutions by `<languageNormalized>:<submissionId>`, refuses folders whose
  metadata names another problem, and is left untouched (with a warning on
  the job) when it is not valid JSON.

## 2026-10-27 — Retry and status rules

- 401 → `NEEDS_AUTH` (job kept; resumed automatically after reconnect).
- 429, or 403 with rate-limit headers/message → `RETRYING` at the hinted
  time **without** consuming an attempt.
- Network/5xx/exhausted ref conflicts → exponential backoff (10 s doubling,
  cap 1 h, jitter), `FAILED_PERMANENT` after 6 attempts (configurable).
- 403 otherwise, 404, 422, unsupported language, missing repo, path
  problems → `FAILED_PERMANENT` with an actionable, token-redacted message.
- Manual retry re-checks eligibility for failed jobs (their reservation was
  released) unless the job was forced.
- Reservations: `RECEIVED/QUEUED/UPLOADING/RETRYING/NEEDS_AUTH` block the
  window like `SUCCESS` does; `FAILED_PERMANENT` and skipped records do not.
- Source code is purged from the job on SUCCESS (default).

## 2026-10-27 — GitHub access in local mode via optional host permissions

Local mode needs `https://github.com/*` (device-flow endpoints send no CORS
headers) and `https://api.github.com/*`. They are declared as
`optional_host_permissions` and requested only when the user clicks
"Connect GitHub", so a default install still has access only to the three
platforms and localhost. Without the grant, jobs report "GitHub is not
connected" (`NEEDS_AUTH`). OAuth Apps only support classic scopes; the
default is `repo` (needed for private repos). `public_repo` would suffice
for a public solutions repo but is not exposed yet.

## 2026-10-27 — OAuth client ID is build-time configuration

`VITE_GITHUB_CLIENT_ID` is read from `packages/extension/.env.local`
(gitignored) and inlined at build time. The client ID is public by design
(device flow has no secret), but keeping it out of git lets other users of
the repo register their own OAuth App.

## 2026-10-27 — Per-package test tsconfigs

`src` is typechecked with only the runtime's types (no DOM in core, no Node
in the extension). Tests get `tsconfig.test.json` with the extra types they
need (DOM for the fake GitHub, Node for reading fixtures), so test-only
types cannot leak into shipped code.

## 2026-10-27 — LeetCode capture design

See [platforms/leetcode.md](platforms/leetcode.md). The page-world hook only
relays `/check/` bodies. Source code is always fetched by submission ID through
the authenticated same-origin GraphQL API and cross-checked against the judged
submission, the page's problem and the language. The URL-based fallback only
uploads submissions younger than 15 minutes. Live probing was not done: plain
requests get a 403, and disguising a client to pass the bot check was rejected
as inappropriate.

## 2026-10-27 — Codeforces capture design

See [platforms/codeforces.md](platforms/codeforces.md). Detection is a DOM
observer on status tables, limited to the logged-in handle's rows. A history
guard uploads only rows seen judging during the page view, or the newest own
row right after a submit redirect, so opening a submissions page never
bulk-uploads past solutions. Source comes from `/data/submitSource` (JSON,
exact bytes) with a text-level fallback on the submission page; a DOM-based
read was rejected because HTML parsing turns CRLF into LF.

## 2026-10-27 — DOM tests with happy-dom, fixtures marked `-text`

Codeforces parsing needs a DOM, so its test files opt into happy-dom
(`// @vitest-environment happy-dom`); other tests stay in Node. A
`.gitattributes` rule marks `packages/*/test/fixtures/**` as `-text` so git
never rewrites line endings in byte-exact fixtures.

## 2026-10-27 — CodeChef endpoints from public client code

CodeChef serves its pages and JS bundles publicly (200 to plain clients),
so its endpoints were found by reading the downloaded client code rather
than guessed: `POST /api/ide/submit`, polling
`GET /api/ide/submit?solution_id=`, `result_code` values and labels,
`/api/submission-code/<id>` → `data.code`, and the problem and language
APIs. Response shapes beyond the fields the client reads remain
assumptions, so the adapter stays "implemented, unverified". See
[platforms/codechef.md](platforms/codechef.md).

## 2026-10-27 — CodeChef capture design

- Only submissions whose submit request was seen on the same page are
  uploaded. Poll results for other IDs are displayed, never uploaded, so
  forged page messages and history browsing cannot trigger uploads.
- `partial_accepted` is not accepted. Unknown `result_code` values stay
  PENDING (never upload) rather than guessing.
- CodeChef's own headers (`x-csrf-token` from `window.csrfToken`,
  `x-cc-ide-key` from `window.ccIdeSkipToken`) are relayed by the page hook
  and reused only for the page's own same-origin requests. They are already
  visible to every page script, are never stored or logged, and never leave
  the content script.
- Assessment-preview submits are ignored.
