# Coding Submission Tracker

Chrome (MV3) extension, with an optional self-hosted Docker backend, that
uploads your first **Accepted** solution per problem (per configurable
period) from LeetCode, Codeforces and CodeChef to your GitHub repository
under `data/`. No copying code, creating folders, writing commit messages or
pushing by hand.

> **Status:** feature-complete (stages 0–7). Everything is tested against a
> fake GitHub and synthetic platform payloads, and the Docker stack has been
> brought up and exercised locally. It has **not** yet been run against the
> live platforms or a real GitHub account; see [Platform status](#platform-status).
> Specification: [AGENT_PROMPT.md](AGENT_PROMPT.md).

## Contents

- [Platform status](#platform-status)
- [Quick start (extension only)](#quick-start-extension-only)
- [What gets uploaded](#what-gets-uploaded)
- [Upload policies](#upload-policies)
- [Backend (optional, Docker)](#backend-optional-docker)
- [Privacy and data retention](#privacy-and-data-retention)
- [Limitations](#limitations)
- [Development and tests](#development-and-tests)
- [Troubleshooting](#troubleshooting)
- [Further docs](#further-docs)

## Platform status

| Platform   | Status                                                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| LeetCode   | implemented, unverified — see [docs/platforms/leetcode.md](docs/platforms/leetcode.md) and [docs/MANUAL_E2E.md](docs/MANUAL_E2E.md#leetcode)       |
| Codeforces | implemented, unverified — see [docs/platforms/codeforces.md](docs/platforms/codeforces.md) and [docs/MANUAL_E2E.md](docs/MANUAL_E2E.md#codeforces) |
| CodeChef   | implemented, unverified — see [docs/platforms/codechef.md](docs/platforms/codechef.md) and [docs/MANUAL_E2E.md](docs/MANUAL_E2E.md#codechef)       |

"Unverified" means no real run against the live site has been recorded yet.
A platform moves to `verified (date, how)` only after its section of the
manual checklist passes.

## Quick start (extension only)

You need Node.js 22+, npm, Chrome 120+ and a GitHub account.

1. **Create a solutions repository** on GitHub with at least one commit
   (e.g. a README), so the branch exists. Keep it separate from this
   project's repository.
2. **Create a GitHub OAuth App** (GitHub → Settings → Developer settings →
   OAuth Apps → New). Any homepage and callback URL work; tick **Enable
   Device Flow**. Copy the **Client ID** (there is no secret to copy).
3. **Build the extension:**

   ```bash
   npm install
   cp packages/extension/.env.example packages/extension/.env.local
   # set VITE_GITHUB_CLIENT_ID=<your client ID> in .env.local
   npm -w @cst/extension run build      # outputs packages/extension/dist
   ```

4. **Load it:** `chrome://extensions` → enable **Developer mode** →
   **Load unpacked** → select `packages/extension/dist`.
5. **Connect GitHub:** open the extension's **Settings** → **Connect GitHub**.
   Chrome asks for access to github.com and api.github.com; allow it, open the
   link shown, enter the code and approve.
6. **Pick the repository:** **Load my repositories** → choose your solutions
   repository and branch → **Save settings**. The popup now says "Waiting for
   submission".

Submit an accepted solution on any supported site. The popup goes
"Submission accepted" → "Uploading to GitHub" → "Upload successful", and the
history shows the file path and a link to the commit.

## What gets uploaded

```text
data/<platform>/<problem-folder>/solution.<ext>
data/<platform>/<problem-folder>/metadata.json
```

Both files land in **one commit**, for example
`feat(solutions): add LeetCode - Two Sum (Python)`. Folder names are
sanitized (`two-sum`, `4a-watermelon`, `flow001-...`). A second solution for
the same problem never overwrites the first; it goes to
`solution-<submissionId>.<ext>`. Identical content already on the branch
counts as uploaded without a new commit. `metadata.json` records submission
IDs, languages and times; it never contains credentials. Source code is
uploaded byte-for-byte (line endings, tabs and trailing spaces preserved).

Only submissions with a confirmed **Accepted** verdict and non-empty source
that matches the captured hash are uploaded. Wrong answers, compile errors,
runtime errors, time and memory limits, partial scores and pending results
never are.

## Upload policies

A problem is uploaded once per **period** (Settings → Upload period), judged
by the submission time in your timezone:

| Period         | Uploads again when                                      |
| -------------- | ------------------------------------------------------- |
| calendar day   | the local date changes (DST-aware)                      |
| calendar week  | a new week starts (Monday or Sunday, your choice)       |
| calendar month | a new month starts                                      |
| rolling 24h    | 24 hours have passed since the last uploaded submission |
| custom hours   | the chosen number of hours has passed                   |
| permanent      | never: only the first accepted solution is uploaded     |

Another accepted solution in the same period (including one in a different
language) is skipped and shown as "Already uploaded this period".

- **Auto-upload off:** accepted solutions wait in the popup's history as
  "Waiting for manual upload". **Upload now** still follows the period.
- **Force upload** (history row) uploads a stored skipped, held or failed
  solution regardless of the period. It never skips the accepted/source
  checks, never overwrites an existing file and cannot recover a submission
  the extension never captured.
- **Retry** / **Retry all failed** re-run failed or needs-reconnect uploads.
  Failed uploads are never counted as uploaded, and retries never create a
  duplicate commit.

## Backend (optional, Docker)

The extension works on its own ("local mode"). The backend moves dedup,
history, the upload queue and the GitHub token into a self-hosted stack:
`api` + `worker` (one image) + Postgres + Redis. Use it if you want the token
kept out of the browser and uploads that survive the browser being closed.

### Run it

You also need Docker with Compose v2.

```bash
cp .env.example .env
# Fill in POSTGRES_PASSWORD and APP_ENCRYPTION_KEY (commands are in the file),
# GITHUB_CLIENT_ID, and EXTENSION_ORIGIN=chrome-extension://<id from chrome://extensions>
docker compose up --build -d
docker compose ps                      # api, worker, postgres, redis; api "healthy"
docker compose logs -f api worker
docker compose down
docker compose down -v   # WARNING: deletes local database data
```

The API listens on `http://127.0.0.1:8787` (change with `API_BIND` /
`API_PORT`). Health checks: `curl http://127.0.0.1:8787/healthz` (process up)
and `/readyz` (Postgres, Redis and migrations; 503 until ready). Postgres and
Redis are reachable only inside the Compose network.

### Pair the extension

```bash
docker compose exec api node dist/cli.js pair
```

Enter the printed code (valid 10 minutes, once) under extension
**Settings → Backend**, then **Connect GitHub** there: the device flow now runs
in the backend, which stores the token encrypted (AES-256-GCM). Settings saved
in the extension are pushed to the backend. **Unpair** returns to local mode.

### Operations

- **Migrations** run automatically when `api` starts (forward-only,
  idempotent). Manually: `docker compose run --rm api node dist/cli.js migrate`.
- **Worker restart mid-upload:** `docker compose restart worker`. An
  interrupted upload is picked up again by the reconciler (on start and every
  `RECONCILE_INTERVAL_MS`); uploads are idempotent, so nothing is committed
  twice. Redis data loss is recovered the same way, because Postgres is the
  source of truth.
- **Rebuild after updating:** `docker compose up --build -d`.
- **Check the image for secrets:** `scripts/check-image.sh coding-submission-tracker:local .env`.
- **Rotate the encryption key:** set the new key as `APP_ENCRYPTION_KEY` with
  a new `APP_ENCRYPTION_KEY_ID`, list the old one in `APP_ENCRYPTION_OLD_KEYS`
  (`id:base64`), restart, then reconnect GitHub so the token is re-sealed with
  the new key.

## Privacy and data retention

- **Your code goes only to your own GitHub repository**, and in backend mode
  first to your own backend on this machine. Nothing is sent anywhere else.
- **GitHub token.** Local mode: stored in the extension's local storage and
  read only by its service worker, never by page scripts, content scripts or
  the popup (enforced by lint rules). Backend mode: stored only in the
  backend, encrypted at rest; the browser never sees it.
- **Source code** is kept until GitHub confirms the commit, then deleted from
  the job (`PURGE_SOURCE_ON_SUCCESS=true` in the backend). Skipped and held
  solutions keep their source so they can be force-uploaded later (in the
  extension at most 500, oldest removed first).
- **Clear local data** (Settings) deletes pending uploads and history in the
  browser, and in the backend when paired (`DELETE /v1/data`). Settings and
  the GitHub connection are kept; **Disconnect GitHub** deletes the token.
- **Logs** (backend) never contain tokens, pairing codes or source code.
- **Permissions:** host access only to leetcode.com, codeforces.com,
  codechef.com and localhost; github.com and api.github.com only after you
  click Connect GitHub (local mode). No cookies, history or `<all_urls>`.

## Limitations

- The three platforms are implemented from documented and observed
  behavior but not yet verified live; their page formats can change. Details
  per platform are in `docs/platforms/`.
- A submission is captured only while its page is open: reloading or closing
  the page before the verdict arrives misses it, and force upload cannot
  recover it. Opening old submissions never bulk-uploads past solutions.
- CodeChef partially accepted results are not uploaded.
- The same problem in a second language within the period is skipped by
  default; use force upload.
- The backend is single-user (the schema keeps `user_id` for later), and its
  rate limits are in memory.
- In backend mode the popup checks for upload results about every 30 seconds
  (Chrome's minimum alarm interval) while uploads are in progress.

## Development and tests

```bash
npm install          # also installs git hooks (husky: commitlint, lint-staged, secret scan)
npm run typecheck
npm run lint
npm test
```

Backend integration tests need Postgres 16 and Redis 7. With the binaries
installed (`initdb`, `pg_ctl`, `redis-server`), the test setup starts
throwaway servers itself; otherwise set `TEST_DATABASE_URL` (a role that can
create databases) and `TEST_REDIS_URL`. Without either, those suites are
skipped with a warning.

Headless smoke test of the built extension (needs Chrome for Testing or
Chromium; branded Chrome ignores `--load-extension`):

```bash
CHROME_PATH=/path/to/chrome npm -w @cst/extension run smoke
```

Commits follow Conventional Commits (enforced by commitlint); see
[AGENT_PROMPT.md §15](AGENT_PROMPT.md).

## Troubleshooting

### Extension problems

| Symptom                                               | Fix                                                                                                                                                       |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "GitHub OAuth client ID is not configured"            | Set `VITE_GITHUB_CLIENT_ID` in `packages/extension/.env.local` and rebuild.                                                                               |
| "GitHub refused device sign-in"                       | Enable **Device Flow** on the OAuth App.                                                                                                                  |
| "Needs GitHub reconnect"                              | The token was revoked or GitHub access was removed: Settings → Connect GitHub. Waiting uploads resume by themselves.                                      |
| "Upload failed" with "not found" or "no write access" | Check the repository and branch in Settings, that the branch has at least one commit, and that the token's account can push to it. Then **Retry**.        |
| "Unsupported language"                                | Nothing was uploaded. Settings → Language extensions: add a line like `my language = cpp`, Save, then **Retry**.                                          |
| Nothing happens after an accepted submission          | Is the platform enabled in Settings? Were you on the submission's page until the verdict? See the platform's section in [MANUAL_E2E](docs/MANUAL_E2E.md). |
| "Already uploaded during this period" but you want it | Use **Force upload** on that history row, or change the period.                                                                                           |

### Backend problems

| Symptom                                                                       | Fix                                                                                                                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `required variable ... is missing a value` on `up`                            | Fill that variable in `.env`.                                                                                                                           |
| `port is already allocated`                                                   | Set `API_PORT` in `.env` to a free port and use that URL when pairing.                                                                                  |
| `api` exits with `APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded`        | Generate a key with the command in `.env.example`.                                                                                                      |
| Uploads stuck in "Needs GitHub reconnect" after changing `APP_ENCRYPTION_KEY` | The old token cannot be decrypted. Reconnect GitHub, or list the old key in `APP_ENCRYPTION_OLD_KEYS` (`id:base64`).                                    |
| `/readyz` returns 503                                                         | `docker compose ps`: wait for Postgres/Redis to be healthy; check `docker compose logs api`.                                                            |
| Upload shows "Retrying" with a rate-limit message                             | GitHub rate limit; the job waits for the reset time without using up attempts.                                                                          |
| Extension says "Backend is not reachable"                                     | Is the stack up? Is the URL `http://127.0.0.1:<API_PORT>`? Submissions stay in the extension's outbox and are delivered later.                          |
| Extension says "pair again" / API answers 403 "Origin not allowed"            | Re-run `cli.js pair`; check that `EXTENSION_ORIGIN` matches the ID on `chrome://extensions` (it changes if you load the extension from another folder). |

## Further docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): flow, packages, invariants
- [docs/DECISIONS.md](docs/DECISIONS.md): dated design decisions and why
- [docs/SECURITY.md](docs/SECURITY.md): security checklist with evidence
- [docs/TEST_MATRIX.md](docs/TEST_MATRIX.md): where each required test lives
- [docs/MANUAL_E2E.md](docs/MANUAL_E2E.md): manual end-to-end checklist
- [docs/platforms/](docs/platforms/): per-platform findings
