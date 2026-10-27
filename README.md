# Coding Submission Tracker

Chrome (MV3) extension + self-hosted Docker backend that uploads your first
**Accepted** solution per problem (per configurable period) from LeetCode,
Codeforces and CodeChef to your GitHub repo under `data/`.

> Status: **under construction**. Stage 0 (foundation) complete. See
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
