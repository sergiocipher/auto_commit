# AGENT_PROMPT.md — Coding Submission Tracker (Browser Extension + Docker Backend)

> Read this entire file before writing any code. It is the single source of truth.
> If anything here conflicts with your assumptions, this file wins. If something is
> genuinely ambiguous, make the smallest safe choice, write it down in `docs/DECISIONS.md`,
> and continue. Do not stop to ask unless you are blocked.

---

## 0. Mission

Build a Chrome (Manifest V3) extension plus a Docker Compose backend that:

1. Detects a **confirmed Accepted** submission on **LeetCode, Codeforces, CodeChef**.
2. Retrieves the **exact** submitted source code and problem metadata.
3. Decides whether it is the **first accepted solution for that problem within the configured period**.
4. Uploads it to the user's GitHub repo under `data/` with a meaningful commit message.
5. Never uploads wrong/pending/failed submissions, never double-uploads, and never loses a pending upload.

Core objective: the user never manually copies code, creates folders, writes commit messages, or pushes.

---

## 1. Non-negotiable ground rules

1. **Honesty over appearance.** Never claim a feature works unless you ran it. Never fake a platform integration, mock a result and call it "supported", or write a README claiming untested behavior.
2. **Platform status labels.** Every platform adapter is labeled in the README as one of:
   `implemented, unverified` → `verified (date, how)`. You may only set `verified` if a real run against the live site was performed and documented. If you cannot reach the site from your environment, the label stays `implemented, unverified` and you provide a manual E2E checklist.
3. **Investigate before implementing each adapter.** Do not assume the three platforms share DOM/API shapes. Record findings in `docs/platforms/<platform>.md` (endpoints used, payload shapes, verdict representation, limitations, date investigated). Save sanitized sample payloads under `packages/extension/test/fixtures/<platform>/`.
4. **Never upload unless** verdict is `ACCEPTED` **and** source code is non-empty and verified to belong to that submission ID. Otherwise surface a clear error.
5. **Do not mark a problem uploaded until GitHub confirms** the write (ref updated, commit SHA returned).
6. **No secrets in the repo, images, logs, error messages, commits, or metadata.** Ever.
7. **Small, tested, committed increments** (see §15). Each stage ends with passing tests and a clean commit.
8. **No skeleton-only deliverables.** Working detection → extraction → dedup → upload → recovery, verified by tests.
9. **Preserve source code byte-for-byte** (no trimming, no newline normalization, no re-formatting). Compare via hash in tests.
10. **Scope discipline.** Only LeetCode, Codeforces, CodeChef. No GFG. Keep architecture extensible, but don't build other platforms.

---

## 2. Decisions already made (do not re-litigate)

| Topic | Decision |
|---|---|
| Deployment model | Single-user, self-hosted (backend on `localhost`). Keep a `user_id` column everywhere so multi-user is possible later. |
| GitHub auth | **OAuth Device Flow** (no client secret needed in the extension). Backend stores token **encrypted at rest** (AES-256-GCM, key from `APP_ENCRYPTION_KEY`). Token never reaches content scripts or popup. Required scope: `repo` (or fine-grained equivalent limited to the target repo; document both). |
| Upload API | **GitHub Git Data API** (blob → tree → commit → ref update) so `solution.ext` + `metadata.json` land in **one atomic commit**. Do not use the Contents API for multi-file writes. |
| Path collisions | Default path `data/<platform>/<problem-key>/solution.<ext>`. If that path exists with **different** content from a different submission, write `solution-<submissionId>.<ext>` instead. **Never overwrite an unrelated solution.** Identical content → treat as success, no commit. |
| Metadata | One `metadata.json` per problem folder, merged read-modify-write, keyed by language + submission. No credentials in it. |
| Source of truth | **PostgreSQL**. Redis is transport only. Extension `chrome.storage` is a cache for popup + early duplicate suppression. |
| Source code retention | Held in the job row until upload succeeds, then purged (configurable; default purge on SUCCESS). Document this in README privacy section. |
| Build order | Shared core first, local sink for first E2E on LeetCode, then backend sink (see §14). |
| Test runner | Vitest everywhere. |
| Language | TypeScript (strict). |

---

## 3. Repository layout

```
.
├── AGENT_PROMPT.md
├── README.md
├── docs/
│   ├── DECISIONS.md
│   ├── ARCHITECTURE.md
│   ├── MANUAL_E2E.md
│   └── platforms/{leetcode,codeforces,codechef}.md
├── packages/
│   ├── shared/            # pure TS: types, zod schemas, slug/path/commit/lang/period logic
│   ├── core/              # dedup engine + GitHub uploader behind interfaces (storage, http, clock)
│   ├── extension/         # MV3 extension (Vite + React popup/options)
│   └── backend/           # api + worker + migrations
├── docker-compose.yml
├── Dockerfile
├── .dockerignore
├── .env.example
├── .gitignore
├── .editorconfig
├── commitlint.config.cjs
├── package.json           # npm workspaces
└── tsconfig.base.json
```

Rules: `shared` and `core` have **zero** browser or Node-specific imports (inject `fetch`, clock, storage). Extension and backend depend on them; never the reverse.

---

## 4. Data models (strict, validated with zod at every boundary)

```ts
type Platform = "leetcode" | "codeforces" | "codechef";
type Verdict  = "ACCEPTED" | "REJECTED" | "PENDING";

interface SubmissionEvent {
  platform: Platform;
  problemKey: string;        // stable ID used for dedup, e.g. "two-sum", "4A", "FLOW001"
  problemSlug: string;       // sanitized folder segment, e.g. "4a-watermelon"
  problemId?: string;
  problemTitle: string;      // fallback "Unknown Problem"
  problemUrl: string;
  submissionId: string;      // platform-native ID
  language: string;          // raw platform language string
  languageNormalized?: string;
  sourceCode: string;        // byte-exact
  sourceSha256: string;      // computed in extension, re-verified in backend
  verdict: Verdict;
  submittedAt: number;       // epoch ms, from platform if available
  detectedAt: number;
  contest?: { id: string; kind: "contest" | "gym" | "problemset" | "practice" };
}

type UploadStatus =
  | "RECEIVED" | "SKIPPED_DUPLICATE" | "SKIPPED_NOT_ELIGIBLE"
  | "QUEUED" | "UPLOADING" | "RETRYING"
  | "SUCCESS" | "FAILED_PERMANENT" | "NEEDS_AUTH";

interface UploadRecord {
  id: string; userId: string; platform: Platform; problemKey: string;
  submissionId: string; language: string; repository: string; branch: string;
  filePath: string; commitMessage: string; commitSha?: string;
  status: UploadStatus; attempts: number; lastError?: string;
  createdAt: number; uploadedAt?: number;
}

type PeriodPolicy =
  | { kind: "calendar_day" }
  | { kind: "rolling_24h" }
  | { kind: "calendar_week"; weekStartsOn: 0 | 1 }
  | { kind: "calendar_month" }
  | { kind: "permanent" }
  | { kind: "custom_hours"; hours: number };

interface Settings {
  autoUpload: boolean;
  period: PeriodPolicy;
  timezone: string;                    // IANA, e.g. "Asia/Kolkata"
  enabledPlatforms: Record<Platform, boolean>;
  uploadMetadata: boolean;
  repo: { owner: string; name: string; branch: string };  // default branch "main"
  languageExtensionOverrides: Record<string, string>;
}
```

Extend these as real platform behavior demands; record changes in `docs/DECISIONS.md`.

---

## 5. Platform adapters

### 5.1 Interface (adapt as needed)

```ts
interface CodingPlatformAdapter {
  readonly platform: Platform;
  canHandle(url: string): boolean;
  start(emit: (e: SubmissionEvent) => void, signal: AbortSignal): void; // observe page/network
  detectSubmission(): Promise<SubmissionEvent | null>;
  getProblemMetadata(): Promise<ProblemMetadata>;
  getAcceptedSourceCode(submissionId: string): Promise<string>;
  normalizeVerdict(raw: unknown): Verdict;
}
```

Each adapter = **pure parsing layer** (payload/DOM snapshot → `SubmissionEvent`, fully fixture-tested) + **thin I/O layer** (hooks, polling, fetch). Handle SPA navigation, dynamic rendering, async verdict updates, and re-emitted events (dedupe by `platform:submissionId` in the content script before messaging).

### 5.2 Investigation protocol (do this before writing each adapter)

1. Document how the platform signals pending → final verdict.
2. Document how source code for a given submission ID is obtained (page data, same-origin API using the user's existing session, or DOM).
3. Document URL forms and how `problemKey`/`problemSlug` derive from them.
4. Document failure modes (logged out, private submission, rate limiting, UI changes).
5. If you cannot reach the site, say so in `docs/platforms/<platform>.md`, implement from best-known behavior, label the adapter `implemented, unverified`, and add precise manual verification steps.

### 5.3 Platform notes (starting hypotheses — **verify, don't trust**)

**LeetCode** — verdict arrives via submission-check polling; after Accepted, submission details (code, language, question slug) are fetchable from same-origin GraphQL using the user's session. Hook network responses from the page world (injected script) and relay to the isolated content script; cross-check by re-fetching details by submission ID. `problemKey` = `titleSlug`.

**Codeforces** — verdicts appear in the status table (`/contest/:id/my`, `/contest/:id/status`, `/problemset/status`, `/problemset/submission/...`, gym, group). Verdict is rendered/updated live via polling. Accepted ≈ "Accepted" verdict element/class. Source via the submission page or its source endpoint (CSRF token may be required). `problemKey` = `<contestId><index>` e.g. `4A`; slug `4a-watermelon`. Handle contest, gym, and problemset forms separately.

**CodeChef** — client-rendered app; the accepted verdict representation and submission/source endpoints **must be discovered from real traffic**. Treat as highest risk. `problemKey` = problem code. Do not guess endpoints silently — document what you observed or label unverified.

---

## 6. Deduplication and eligibility

- Key: `(userId, platform, problemKey)`. Titles never participate in the key.
- Idempotency key: `(platform, submissionId)` — unique constraint. Repeats return the existing record, never a new job.
- Eligibility = does a `SUCCESS` upload for the same key exist **within the current window** per `PeriodPolicy`, evaluated with the submission's `submittedAt` in the user's IANA `timezone`?
  - `calendar_day/week/month`: compare window buckets in the user's timezone (handle DST, month length, week start).
  - `rolling_24h` / `custom_hours`: `submittedAt - lastSuccess.submittedAt < window`.
  - `permanent`: any prior SUCCESS blocks.
- **Reservation model:** when a job is created (`QUEUED`) it reserves the slot so concurrent events can't both pass. Reservation is released if the job ends `FAILED_PERMANENT`. Only `SUCCESS` counts as "uploaded" for future windows.
- Serialize per key with a transactional advisory lock (`pg_advisory_xact_lock(hash(userId, platform, problemKey))`).
- **Force upload** bypasses period eligibility but **not** idempotency/accepted/source checks.
- Same problem, different language in the same window: still skipped by default policy (document), but force-upload is available. Different languages never overwrite each other's files.

---

## 7. GitHub upload spec (worker)

Paths: `data/<platform>/<problemSlug>/solution.<ext>` (+ `metadata.json` if enabled). Sanitize slugs: lowercase, `[a-z0-9-]`, collapse repeats, trim, max length, no `..`, no leading dots, reject empty (fallback to `problemKey`). Codeforces slug includes the ID prefix to avoid collisions.

Commit message (exact format, sanitized, single line, ≤ 100 chars where possible):

```
feat(solutions): add <Platform> - <Problem Name> (<Language>)
```
Platform display: `LeetCode`, `Codeforces`, `CodeChef`. Language display: `C++`, `Python`, `Java`, etc. If the title is missing: `Unknown Problem`. Add the problem key only when needed to disambiguate (e.g. `Codeforces - 4A Watermelon (C++)` style only if the title is missing or ambiguous — document the rule). Submission ID goes in `metadata.json`, not the message.

Algorithm (idempotent):
1. Load token → verify; resolve branch head commit + tree.
2. Read existing target path(s). If identical blob SHA → mark SUCCESS (no commit), record existing commit SHA if known.
3. If path exists with different content from another submission → switch to `solution-<submissionId>.<ext>`.
4. Create blobs → tree → commit (parent = current head) → update ref **without force**.
5. On ref conflict (422/409) → refetch head, rebuild, retry (bounded).
6. Only after the ref update succeeds: persist `SUCCESS`, `commitSha`, `uploadedAt`.

Error classes:
- **Retryable:** network, 5xx, 429/secondary rate limit (honor `Retry-After`/`x-ratelimit-reset`), ref conflict.
- **NEEDS_AUTH:** 401/bad credentials, revoked token (job kept; resumes after reconnect).
- **Permanent:** 404 repo/branch, 403 without write access, validation failures, unsupported/empty source.
- Backoff: exponential with jitter, max attempts configurable (default 6), no infinite loops. Never swallow failures — every terminal failure is stored with an actionable `lastError` (tokens redacted).

Language → extension map lives in `shared`, covers at least C, C++, Java, Python, JavaScript, TypeScript, Go, Rust, C#, Kotlin, PHP, Ruby, plus platform-specific variants (e.g. "Python 3", "PyPy 3", "C++17 (GCC)", "GNU G++20", "Kotlin 1.9"), overridable via settings. Unknown language → clear error (or user-mapped extension), never a silent `.txt`.

---

## 8. Backend (Express + TypeScript)

### 8.1 Endpoints (all JSON, zod-validated, versioned under `/v1`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | liveness (no deps) |
| GET | `/readyz` | readiness (Postgres + Redis reachable, migrations applied) |
| POST | `/v1/pair` | one-time pairing → returns per-install bearer token (store only its hash) |
| POST | `/v1/github/device/start` | begin device flow |
| POST | `/v1/github/device/poll` | poll for token, store encrypted |
| DELETE | `/v1/github` | disconnect + delete stored token |
| GET | `/v1/github/repos`, `/v1/github/repos/:owner/:name/branches` | selection UI |
| GET/PUT | `/v1/settings` | settings |
| POST | `/v1/submissions` | ingest event → dedup decision → enqueue |
| GET | `/v1/uploads`, `/v1/uploads/:id` | history/status |
| POST | `/v1/uploads/:id/retry` | retry failed/NEEDS_AUTH |
| POST | `/v1/uploads/force` | force-upload a stored accepted submission |
| DELETE | `/v1/data` | clear local data |

Security: bearer auth on all `/v1` except pairing; CORS restricted to the configured `chrome-extension://<id>` origin; body size limits; rate limiting; structured logs with secret redaction; generic error bodies.

### 8.2 PostgreSQL (SQL migrations in `packages/backend/migrations`, run on `api` start or via `npm run migrate`)

Minimum tables: `users`, `installs` (token hash), `settings`, `github_connections` (encrypted token, key id, scopes), `submissions`, `upload_jobs` (status, attempts, next_attempt_at, last_error, source_code nullable, commit_sha, file_path, commit_message), plus unique indexes:
- `(platform, submission_id)` unique
- partial unique index preventing two active reservations for one `(user_id, platform, problem_key)` in the same bucket where applicable

Migrations must be forward-only, idempotent in tooling, and tested on an empty DB.

### 8.3 Queue and worker (BullMQ)

- `jobId = <platform>:<submissionId>` → duplicate enqueues collapse.
- Postgres row is authoritative; BullMQ job references the row ID only (no source code in Redis).
- Worker updates DB state at each transition inside transactions.
- **Reconciler** on worker startup and every N minutes: re-enqueue DB jobs stuck in `QUEUED`/`UPLOADING`/`RETRYING` with no live BullMQ job (covers Redis loss and worker crash).
- Graceful shutdown: finish or release current job; stalled-job detection enabled.
- Rate-limit handling delays the job instead of burning attempts.

---

## 9. Docker and Compose

Services: `api`, `worker`, `postgres`, `redis`. The extension is **not** containerized.

Requirements:
- `Dockerfile`: multi-stage (deps → build → slim runtime), non-root user, `NODE_ENV=production`, only production deps in the final stage, no `.env`/secrets copied.
- `docker-compose.yml`:
  - `postgres:16-alpine` with named volume, healthcheck `pg_isready`.
  - `redis:7-alpine` with `--appendonly yes`, named volume, healthcheck `redis-cli ping`.
  - `api` and `worker` use the same image with different commands; `depends_on` with `condition: service_healthy`.
  - `api` healthcheck hits `/readyz`.
  - Internal network; services address each other by name (`postgres`, `redis`). Publish only the API port (bind `127.0.0.1` by default).
  - Env via `env_file`/`environment` variables only.
- `.dockerignore`: `node_modules`, `dist`, `.git`, `.env*`, tests artifacts, docs not needed.
- `.env.example`: `PORT`, `DATABASE_URL`, `REDIS_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` (only if ever needed; device flow doesn't), `GITHUB_CALLBACK_URL` (only if used), `APP_ENCRYPTION_KEY` (with a command to generate it), `EXTENSION_ORIGIN`, `LOG_LEVEL`, `UPLOAD_MAX_ATTEMPTS`, `PURGE_SOURCE_ON_SUCCESS`. No real values.
- Document in README (and verify them if Docker is available; otherwise state they were **not** run):

```bash
docker compose up --build -d
docker compose ps
docker compose logs -f api worker
docker compose down
docker compose down -v   # WARNING: deletes local database data
```
Plus: migrations, health checks, running tests, restarting the worker mid-job, troubleshooting (port conflicts, bad encryption key, Redis/Postgres not ready, GitHub rate limits, extension can't reach API).

---

## 10. Extension (MV3)

- **Permissions:** minimum. Host permissions only for `leetcode.com`, `codeforces.com`, `codechef.com` and the configured backend origin. No `<all_urls>`, no cookies permission, no browsing history.
- **Content scripts** per platform; page-world injection only where network hooking is required, communicating via `window.postMessage` with strict origin/shape validation.
- **Service worker:** validates messages (zod + sender check), computes/validates hash, sends to backend, keeps a small pending outbox in `chrome.storage.local` so events survive worker restarts, retries delivery with bounded backoff.
- **Popup (React):** GitHub connection status, repo + branch, current platform, last detected submission + verdict, upload status, current dedup period, uploaded count, recent history, controls (connect/disconnect, repo/branch select, auto-upload toggle, period config, platform toggles, metadata toggle, retry failed, manual/force upload, open repo, clear local data). Statuses: *Waiting for submission · Submission accepted · Uploading to GitHub · Upload successful · Already uploaded during this period · Upload failed — retry available · Needs GitHub reconnect*. **Success is shown only after backend reports `SUCCESS`.**
- Render all platform-derived strings as text (no `innerHTML`/`dangerouslySetInnerHTML`).
- Local mode (Stages 2–5) uses the same `UploadSink` interface from `core` with a `chrome.storage` implementation; backend mode (Stage 6) swaps in `BackendSink`.

---

## 11. Security and privacy checklist

- [ ] No token in content scripts, popup state, logs, error text, commits, metadata.
- [ ] Token encrypted at rest (AES-256-GCM, random IV per record, key from env, key-id for rotation).
- [ ] Bearer pairing token stored hashed; constant-time compare.
- [ ] CORS locked to the extension origin; API bound to localhost by default.
- [ ] Message validation on every boundary; unknown fields rejected.
- [ ] Path traversal impossible (tests with `../`, absolute paths, unicode tricks, empty titles).
- [ ] Log redaction tested.
- [ ] `docker history`/image contains no secrets.
- [ ] Disconnect GitHub + clear local data work and are tested.
- [ ] README documents platform limitations and data retention (source code is sent only to the user's own backend, then to GitHub).

---

## 12. Test matrix (Vitest; mocked GitHub; real Postgres/Redis where available)

For **each** platform (fixture-driven adapter tests) plus shared/backend tests:

1. Accepted → upload workflow triggered.
2. Wrong Answer / CE / RE / TLE / MLE / Pending → never uploads.
3. Repeated events for same submission → no duplicate upload.
4. Second accepted for same problem → follows configured window.
5. New window → uploads again.
6. Different problems independent (incl. same title across platforms).
7. Source code preserved byte-exactly (hash compare, CRLF, tabs, trailing spaces, unicode).
8. Correct extension per language (incl. platform-specific names).
9. File lands under `data/` with the exact commit-message format.
10. Failed upload does not mark problem uploaded; retry succeeds without duplicate commit.
11. Concurrent identical events → exactly one job (race test).
12. Worker restart / Redis flush → pending jobs recovered by reconciler.
13. Service worker restart → outbox and dedup state preserved.
14. Missing source / unsupported language → clear error, no upload.
15. 401 → `NEEDS_AUTH`, resumes after reconnect; 429 → delayed not failed; 5xx → bounded retries; 404/403 → permanent.
16. Existing-file conflict → suffix path, nothing overwritten; identical content → no commit.
17. Ref-update conflict → rebuild and retry.
18. Timezone/calendar boundaries: midnight in user's TZ, DST changes, month ends, week start Sun vs Mon, leap day.
19. Force upload bypasses window but not accepted/source checks.
20. Slug/path sanitization and traversal attempts.
21. Secrets never appear in logs/errors/metadata.

Also provide `docs/MANUAL_E2E.md`: step-by-step checklist per platform (login, submit accepted, submit wrong answer, resubmit within window, resubmit next window, two languages, kill worker mid-upload, verify repo contents and commit message).

---

## 13. Definition of Done

- Accepted submission on each platform is detected (or its status honestly labeled `implemented, unverified` with manual steps).
- Exact source retrieved; period policy applied; uploaded under `data/`; meaningful commit; no duplicates; failures recoverable.
- `docker compose up --build -d` brings up the stack (verified, or explicitly reported as not verified).
- Popup status and history are accurate.
- `npm test` green; lint and typecheck green.
- README lets a fresh developer install, configure, load unpacked, run, test and troubleshoot.

---

## 14. Stages (each ends with: tests green → docs updated → commit → short report)

| Stage | Scope | Exit criteria |
|---|---|---|
| **0** | Monorepo, TS strict, ESLint/Prettier, Vitest, commitlint/husky, `shared` package: slug/path sanitizer, language map, commit-message builder, period-window math | Unit tests incl. TZ/DST/path-traversal pass |
| **1** | MV3 shell, adapter interface, content-script messaging, service worker outbox, popup skeleton, settings persistence | Loads unpacked; message validation tests |
| **2** | `core` dedup engine + Git Data API uploader (mocked), `UploadSink` local impl, **LeetCode adapter**, device-flow auth for local mode | LeetCode → GitHub flow works against mocks; live-run steps documented/executed |
| **3** | Codeforces adapter (contest, gym, problemset) | Fixture tests; platform doc; manual checklist |
| **4** | CodeChef adapter (investigate first) | Same; honest status label |
| **5** | Full policy set, force upload, history/retry UI | Boundary tests green |
| **6** | Backend: Postgres migrations, Redis, BullMQ, API, worker, reconciler, `BackendSink`, Dockerfile, Compose, healthchecks | Integration tests; restart-recovery tests; Compose verified or flagged |
| **7** | Security pass, remaining matrix, README, MANUAL_E2E, troubleshooting, final polish | §11 checklist complete, §13 satisfied |

After each stage, post a report with: what changed, what was tested (with exact commands and results), what was **not** verified and why, known limitations, next stage plan.

---

## 15. Git workflow and commit rules

### 15.1 Setup (Stage 0, first commits)

```bash
git init -b main
# .gitignore BEFORE the first `git add`: node_modules, dist, build, coverage,
# .env, .env.*, !.env.example, *.pem, *.key, .DS_Store, *.log, .vite, .turbo,
# docker volumes, test-results, extension zip artifacts
```
Never run `git add .` blindly — review `git status` and `git diff --staged` before every commit. Before committing, grep the staged diff for token-like strings (`ghp_`, `github_pat_`, `gho_`, `BEGIN PRIVATE KEY`, `APP_ENCRYPTION_KEY=` with a value).

### 15.2 Branching

- `main` is always green and releasable.
- One branch per stage/feature: `stage/0-foundation`, `stage/2-leetcode-github`, `feat/codeforces-adapter`, `fix/dedup-race`, `docs/readme-docker`, `chore/ci`.
- Merge into `main` with `--no-ff` (or squash only if the branch history is noisy) after tests pass. Tag stage completions: `v0.<stage>.0` (e.g. `v0.2.0` after Stage 2).

### 15.3 Conventional Commits for **this repository's development**

Format:

```
<type>(<scope>): <imperative, lowercase summary, ≤ 72 chars, no trailing period>

<body: what and why, wrapped at ~80 cols — required for non-trivial changes>

<footer: BREAKING CHANGE: ..., Refs: stage-2, Fixes #n>
```

Types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`, `revert`, `style`.

Scopes: `shared`, `core`, `extension`, `adapter-leetcode`, `adapter-codeforces`, `adapter-codechef`, `popup`, `worker`, `api`, `db`, `queue`, `docker`, `github`, `dedup`, `security`, `docs`, `deps`, `repo`.

> **Do not confuse the two commit conventions.** The extension itself creates commits in the *user's solutions repo* with `feat(solutions): add <Platform> - <Problem> (<Lang>)`. The scope `solutions` is **reserved** for those generated commits; never use it for this project's own development commits.

Rules:
1. **Atomic:** one logical change per commit; code and its tests in the same commit.
2. **Buildable:** every commit passes typecheck + tests (`npm run typecheck && npm test`). Do not commit broken intermediate states to `main`.
3. **Imperative mood:** "add", "fix", "handle" — not "added"/"fixes".
4. **Explain why** in the body for anything non-obvious (design decisions, trade-offs, platform quirks, links to `docs/DECISIONS.md`).
5. **Never** commit: secrets, `.env`, build output, `node_modules`, large binaries, real user data, unsanitized recorded payloads containing cookies/tokens/personal info.
6. **Generated/fixtures:** sanitize fixtures before committing; mention the sanitization in the commit body.
7. **No vague messages:** forbidden — `update`, `fix stuff`, `wip`, `changes`, `misc`, `final`.
8. **Breaking changes** (schema, API, message formats) use `!` and a `BREAKING CHANGE:` footer, and include a migration note.
9. Do not rewrite published history on `main`. Use `git revert` for mistakes there. Squashing/fixup is fine on unmerged local branches.
10. Use `git commit -S` only if signing is configured; do not block on it.

### 15.4 Enforcement

Add `commitlint` (`@commitlint/config-conventional` with the scope list above) and `husky` hooks:
- `commit-msg`: commitlint
- `pre-commit`: lint-staged (eslint + prettier on staged files) and a secrets grep
- `pre-push`: `npm run typecheck && npm test`

### 15.5 Example commit sequence

```
chore(repo): initialize npm workspaces with strict typescript and vitest
chore(repo): add gitignore, editorconfig, and env example
build(repo): add eslint, prettier, husky, and commitlint
feat(shared): add filesystem-safe problem slug sanitizer
test(shared): cover path traversal and unicode edge cases in slugging
feat(shared): add language to file extension map with overrides
feat(shared): add commit message builder with unknown-problem fallback
feat(shared): add timezone-aware period window calculator
test(shared): cover dst, month-end, and week-start boundaries
docs(repo): record initial architecture decisions
feat(extension): add manifest v3 shell with minimal host permissions
feat(extension): validate content-script messages with zod schemas
feat(extension): persist pending outbox across service worker restarts
feat(core): add dedup engine with reservation semantics
feat(github): implement atomic git data api uploader
fix(github): rebuild tree and retry on ref update conflict
feat(adapter-leetcode): parse accepted submission details into events
test(adapter-leetcode): add fixtures for accepted, wrong answer, pending
docs(adapter-leetcode): document investigated endpoints and limitations
feat(db): add initial schema with submission idempotency constraint
feat(queue): add bullmq upload worker with exponential backoff
feat(worker): add reconciler to recover orphaned jobs after restart
build(docker): add multi-stage dockerfile and compose stack with healthchecks
docs(docker): document compose commands and troubleshooting
```

Example of a good full message:

```
fix(dedup): serialize concurrent events per problem key

Two accepted events for the same problem arriving within milliseconds could
both pass the eligibility check before either reserved the slot, producing
duplicate upload jobs. Take a transactional advisory lock keyed by
(user, platform, problemKey) before evaluating the window and inserting
the reservation.

Adds a race test that fires 20 concurrent ingests and asserts exactly one job.

Refs: stage-6
```

### 15.6 PR / merge checklist (even if self-merged)

- [ ] Typecheck, lint, tests pass
- [ ] No secrets in diff (`git diff main...HEAD | grep -Ei 'ghp_|github_pat_|private key'` returns nothing)
- [ ] Docs updated (`README`, `DECISIONS`, platform docs)
- [ ] Platform status labels accurate
- [ ] Commit history clean and conventional

---

## 16. Working style

1. Start by writing `docs/ARCHITECTURE.md` from §3–§10 (short), then begin Stage 0.
2. Prefer small pure functions with tests over clever code.
3. When blocked by an unreachable platform/service, implement against fixtures, label status honestly, and move on.
4. Keep a running `docs/DECISIONS.md` (date, decision, reason, alternatives).
5. Finish each stage with the report format in §14. Do not begin the next stage until the current one is committed and green.
