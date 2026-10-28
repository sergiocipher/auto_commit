# Codeforces adapter

**Status: implemented, unverified.** Investigated 2026-10-27. Nothing here has been
observed against the live site yet.

## What could and could not be checked

- From the development environment, `https://codeforces.com` answers plain
  HTTP clients with **403** (bot protection), and there is no logged-in session.
  Disguising requests to get past the bot check was not attempted.
- The markup and endpoints below are the **best-known behavior** of
  Codeforces' web UI, not recorded traffic. The fixtures in
  `packages/extension/test/fixtures/codeforces/` are **synthetic** (each HTML
  file starts with a `_synthetic` comment; JSON has `"_synthetic": true`) and
  contain made-up handles only.
- Confirm or correct with [MANUAL_E2E.md](../MANUAL_E2E.md#codeforces).

## Pages and URL forms

The content script runs on every `https://codeforces.com/*` page and looks
for a status table (`table.status-frame-datatable`). That covers:

| Page                    | Example                         | Problem link in the row                |
| ----------------------- | ------------------------------- | -------------------------------------- |
| Contest, my submissions | `/contest/4/my`                 | `/contest/4/problem/A`                 |
| Contest status          | `/contest/4/status`             | `/contest/4/problem/A`                 |
| Problemset status       | `/problemset/status?my=on`      | `/problemset/problem/4/A`              |
| Gym                     | `/gym/100001/my`                | `/gym/100001/problem/A`                |
| Group contest           | `/group/<id>/contest/345678/my` | `/group/<id>/contest/345678/problem/C` |
| Profile submissions     | `/submissions/<handle>`         | any of the above                       |

Mirrors (`m1/m2/m3.codeforces.com`, `codeforc.es`) are **not** supported
because they are outside the extension's host permissions.

## Row structure (hypothesis)

```html
<tr data-submission-id="300000003">
  <td><a href="/contest/4/submission/300000003">300000003</a></td>
  <td><span class="format-time">Oct/27/2026 10:03</span></td>
  <td><a href="/profile/alice">alice</a></td>
  <td><a href="/contest/4/problem/A">A - Watermelon</a></td>
  <td>GNU G++20 13.2 (64 bit, winlibs)</td>
  <td class="status-verdict-cell" waiting="true">
    <span class="submissionVerdictWrapper" submissionVerdict="TESTING">
      <span class="verdict-waiting">Running on test 5</span></span
    >
  </td>
  ...
</tr>
```

Codeforces updates verdict cells **live** while judging. The adapter re-scans
on DOM mutations (debounced 250 ms).

**Verdict rule:**

- PENDING if `waiting="true"`, or `submissionVerdict` is `TESTING`, `SUBMITTED` or empty.
- ACCEPTED only if `submissionVerdict="OK"`.
- REJECTED for every other final code: `WRONG_ANSWER`, `TIME_LIMIT_EXCEEDED`,
  `MEMORY_LIMIT_EXCEEDED`, `RUNTIME_ERROR`, `COMPILATION_ERROR`, `SKIPPED`,
  `CHALLENGED`, `PARTIAL`, and so on.
- If the attribute is missing, the `verdict-accepted` / `verdict-rejected` /
  `verdict-waiting` classes are used. A bare "Accepted" text is never trusted.

## Whose submission, and which ones

- The logged-in handle is read from the header (`.lang-chooser a[href^="/profile/"]`).
  Only rows whose author link matches it, case-insensitively, are considered.
  Status pages list everyone's submissions.
- **History guard:** an Accepted row is captured only if the adapter **saw it
  pending** during this page view (judged while watching), **or** the page was
  reached straight from a submit form (`document.referrer` ends in `/submit`),
  the row is the newest own row, and this is the first scan (fast judging).
  Accepted rows already on the page from earlier are never uploaded.

## How the source code is obtained (hypothesis)

1. **Primary:** `POST /data/submitSource` with `submissionId` and `csrf_token`
   (from `<meta name="X-Csrf-Token">`; also sent as the `X-Csrf-Token` header).
   The JSON response has `source`. This is what the "view source" popup on
   status pages uses. JSON keeps the exact bytes, including `\r\n`.
2. **Fallback:** the submission page linked from the row
   (`/contest/<c>/submission/<id>`, `/problemset/submission/<c>/<id>`, gym and
   group equivalents). It is fetched as **text** and the
   `<pre id="program-source-text">` body is extracted and entity-decoded
   without running an HTML parser, because HTML parsing would normalize CRLF
   to LF. One newline right after `<pre>` is dropped, as the HTML spec does.
   If the block contains markup (pre-highlighted), the capture fails instead
   of guessing.

Both requests are same-origin and use the user's session. The submission ID
comes from the row's own link, so the code always belongs to that submission.

## Keys, slugs and metadata

- `problemKey` = `<contestId><index>`, e.g. `4A`, `1950C1`, `100001A` (gym),
  `345678C` (group). Gym and group contests use their own ID ranges, so keys
  don't collide with regular contests.
- `problemSlug` = `<key>-<title>`, e.g. `4a-watermelon`, so the folder is
  `data/codeforces/4a-watermelon/`.
- `contest` = `{ id, kind }`, where kind is `contest`, `problemset` or `gym`.
  Group contests are recorded as `gym` with id `<groupId>/<contestId>`.
- `language` = the raw column text (`GNU G++20 13.2 (64 bit, winlibs)`),
  mapped by the shared language table.
- Commit: `feat(solutions): add Codeforces - 4A Watermelon (C++)`.

## Limitations

| Situation                                       | Behavior                                                                                                                                                                                                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Logged out                                      | No handle → nothing observed.                                                                                                                                                                                                                   |
| `submittedAt`                                   | Approximated by when the row was first seen pending (or detection time). Codeforces' time column is in the user's configured timezone, which the page doesn't expose reliably. Near midnight, the period bucket can be off by the judging time. |
| Submissions page closed before judging finishes | Not captured. Reopen the "my" page after it is judged: still not captured (history guard). Force upload cannot help: it only acts on submissions the extension stored.                                                                          |
| Markup or endpoint change                       | Rows that can't be fully parsed are skipped; no guessing.                                                                                                                                                                                       |
| Interactive or partial-scoring gym problems     | Only `OK` counts as accepted.                                                                                                                                                                                                                   |
