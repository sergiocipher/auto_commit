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
