# Coding Submission Tracker

Chrome (MV3) extension + self-hosted Docker backend that uploads your first
**Accepted** solution per problem (per configurable period) from LeetCode,
Codeforces and CodeChef to your GitHub repo under `data/`.

> Status: **under construction**. Stages 0–5 complete: local-mode upload to
> GitHub, LeetCode, Codeforces and CodeChef adapters, every upload-period
> policy, manual and force upload, and upload history with retry (tested
> against a fake GitHub and synthetic platform payloads; not yet run against
> the live sites). See
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
