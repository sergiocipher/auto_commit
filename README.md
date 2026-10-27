# Coding Submission Tracker

Chrome (MV3) extension + self-hosted Docker backend that uploads your first
**Accepted** solution per problem (per configurable period) from LeetCode,
Codeforces and CodeChef to your GitHub repo under `data/`.

> Status: **under construction**. Stages 0 (foundation) and 1 (extension shell) complete;
> no platform adapter or upload path exists yet. See
> [AGENT_PROMPT.md](AGENT_PROMPT.md) for the specification,
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
> [docs/DECISIONS.md](docs/DECISIONS.md).

## Platform status

| Platform   | Status      |
| ---------- | ----------- |
| LeetCode   | not started |
| Codeforces | not started |
| CodeChef   | not started |

## Development

```bash
npm install          # also installs git hooks (husky)
npm run typecheck
npm run lint
npm test
```

### Extension

```bash
npm -w @cst/extension run build     # outputs packages/extension/dist
```

Load it: open `chrome://extensions`, enable **Developer mode**, click
**Load unpacked** and select `packages/extension/dist`.

Headless smoke test of the unpacked build (needs Chrome for Testing or
Chromium; branded Chrome ignores `--load-extension`):

```bash
CHROME_PATH=/path/to/chrome npm -w @cst/extension run smoke
```
