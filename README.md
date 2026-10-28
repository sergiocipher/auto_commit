# Coding Submission Tracker

Chrome (MV3) extension + self-hosted Docker backend that uploads your first
**Accepted** solution per problem (per configurable period) from LeetCode,
Codeforces and CodeChef to your GitHub repo under `data/`.

> Status: **under construction**. Stages 0–6 complete: local-mode upload to
> GitHub, LeetCode, Codeforces and CodeChef adapters, every upload-period
> policy, manual and force upload, upload history with retry, and the
> optional Docker backend (Postgres, Redis/BullMQ worker, API). Tested
> against a fake GitHub and synthetic platform payloads; not yet run against
> the live sites or real GitHub. See
> [AGENT_PROMPT.md](AGENT_PROMPT.md) for the specification,
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
> [docs/DECISIONS.md](docs/DECISIONS.md).

## Platform status

| Platform   | Status                                                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| LeetCode   | implemented, unverified — see [docs/platforms/leetcode.md](docs/platforms/leetcode.md) and [docs/MANUAL_E2E.md](docs/MANUAL_E2E.md#leetcode)       |
| Codeforces | implemented, unverified — see [docs/platforms/codeforces.md](docs/platforms/codeforces.md) and [docs/MANUAL_E2E.md](docs/MANUAL_E2E.md#codeforces) |
| CodeChef   | implemented, unverified — see [docs/platforms/codechef.md](docs/platforms/codechef.md) and [docs/MANUAL_E2E.md](docs/MANUAL_E2E.md#codechef)       |

## Upload policies

A problem is uploaded once per **period** (Settings → Upload period),
judged by the submission time in your timezone:

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
  checks, never overwrites an existing file (a second solution lands at
  `solution-<submissionId>.<ext>`) and cannot recover a submission the
  extension never captured.
- **Retry** / **Retry all failed** re-run failed or needs-reconnect uploads.

Skipped and held solutions keep their source code in the extension so they
can be forced later (at most 500, oldest removed first). **Clear local
data** removes them.

## Development

```bash
npm install          # also installs git hooks (husky)
npm run typecheck
npm run lint
npm test
```

Backend integration tests need Postgres 16 and Redis 7. With the binaries
installed (`initdb`, `pg_ctl`, `redis-server`), the test setup starts
throwaway servers itself; otherwise set `TEST_DATABASE_URL` (a role that can
create databases) and `TEST_REDIS_URL`. Without either, those suites are
skipped with a warning.

### Extension

```bash
cp packages/extension/.env.example packages/extension/.env.local
# set VITE_GITHUB_CLIENT_ID to your OAuth App's client ID (Device Flow enabled)
npm -w @cst/extension run build     # outputs packages/extension/dist
```

First run: open the extension's **Settings**, click **Connect GitHub**
(Chrome asks for access to github.com and api.github.com), enter the code
shown on github.com/login/device, then pick your **solutions** repository
and branch. Full checklist: [docs/MANUAL_E2E.md](docs/MANUAL_E2E.md).

**Privacy (local mode):** your GitHub token is stored in the extension's
local storage and read only by its service worker, never by page scripts or
the popup. Accepted source code is kept in the extension until GitHub
confirms the commit, then deleted from the job. Code goes only to GitHub.

Load it: open `chrome://extensions`, enable **Developer mode**, click
**Load unpacked** and select `packages/extension/dist`.

Headless smoke test of the unpacked build (needs Chrome for Testing or
Chromium; branded Chrome ignores `--load-extension`):

```bash
CHROME_PATH=/path/to/chrome npm -w @cst/extension run smoke
```

## Backend (optional, Docker)

The extension works on its own ("local mode"). The backend moves dedup,
history, the upload queue and the GitHub token into a self-hosted stack:
`api` + `worker` (one image) + Postgres + Redis.

### Run it

```bash
cp .env.example .env
# Fill in POSTGRES_PASSWORD, APP_ENCRYPTION_KEY (commands are in the file),
# GITHUB_CLIENT_ID, and EXTENSION_ORIGIN=chrome-extension://<id from chrome://extensions>
docker compose up --build -d
docker compose ps                      # api, worker, postgres, redis; api "healthy"
docker compose logs -f api worker
docker compose down
docker compose down -v   # WARNING: deletes local database data
```

The API listens on `http://127.0.0.1:8787` (change with `API_BIND` /
`API_PORT`). Health checks: `curl http://127.0.0.1:8787/healthz` (process up)
and `/readyz` (Postgres, Redis and migrations; 503 until ready).

### Pair the extension

```bash
docker compose exec api node dist/cli.js pair
```

Enter the printed code (valid 10 minutes, once) under extension
**Settings → Backend**, then **Connect GitHub** there: the device flow now
runs in the backend, which stores the token encrypted (AES-256-GCM). Settings
saved in the extension are pushed to the backend. **Unpair** returns to local
mode.

### Operations

- **Migrations** run automatically when `api` starts (forward-only,
  idempotent). Manually: `docker compose run --rm api node dist/cli.js migrate`.
- **Worker restart mid-upload**: `docker compose restart worker`. An
  interrupted upload is picked up again by the reconciler (on start and every
  `RECONCILE_INTERVAL_MS`); uploads are idempotent, so nothing is committed
  twice. Redis data loss is recovered the same way: Postgres is authoritative.
- **Privacy**: source code goes from the extension to your backend, is kept in
  the job row until GitHub confirms the commit, then deleted
  (`PURGE_SOURCE_ON_SUCCESS=true`). Skipped and held submissions keep their
  source so they can be forced later; **Clear local data** (or
  `DELETE /v1/data`) removes them. Logs never contain tokens or source code.

### Troubleshooting

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
