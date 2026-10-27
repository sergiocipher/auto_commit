# Coding Submission Tracker

Chrome (MV3) extension + self-hosted Docker backend that uploads your first
**Accepted** solution per problem (per configurable period) from LeetCode,
Codeforces and CodeChef to your GitHub repo under `data/`.

> Status: **under construction**. Stages 0–3 complete: local-mode upload to
> GitHub plus the LeetCode and Codeforces adapters (tested against a fake
> GitHub and synthetic platform payloads; not yet run against the live sites). See
> [AGENT_PROMPT.md](AGENT_PROMPT.md) for the specification,
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
> [docs/DECISIONS.md](docs/DECISIONS.md).

## Platform status

| Platform   | Status                                                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| LeetCode   | not started                                                                                                                                        |
| Codeforces | implemented, unverified — see [docs/platforms/codeforces.md](docs/platforms/codeforces.md) and [docs/MANUAL_E2E.md](docs/MANUAL_E2E.md#codeforces) |
| CodeChef   | not started                                                                                                                                        |

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
