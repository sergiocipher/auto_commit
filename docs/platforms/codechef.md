# CodeChef adapter

**Status: implemented, unverified.** Investigated 2026-10-27. No submission was
observed live (that needs a logged-in session).

## How this was investigated

`https://www.codechef.com` serves public pages to plain HTTP clients (200).
CodeChef is a client-rendered React app, so its public JavaScript bundle
(`/build/react2/assets/index-*.js`) and its non-vendor lazy chunks were
downloaded once (static assets, fetched with a delay between requests) and
searched for API calls. No login, no submissions, no disguised client.

Everything below marked **(code)** was read from that client code on
2026-10-27. Response _shapes_ beyond the fields the client reads are
**assumed**. The fixtures in `packages/extension/test/fixtures/codechef/`
are synthetic (`"_synthetic": true`), built around those fields.

## Submit and verdict flow (code)

1. The IDE submits with
   `POST /api/ide/submit` (`Content-Type: application/x-www-form-urlencoded`).
   It sends form fields `sourceCode`, `language` (numeric language id),
   `problemCode` and `contestCode` (`PRACTICE` for practice), plus headers
   `X-Requested-With: XMLHttpRequest`, `x-csrf-token: window.csrfToken` and,
   when set, `x-cc-ide-key: window.ccIdeSkipToken` for `api/ide` calls.
   - The response has `upid` (the submission id). `status: "error"` with
     `errors[]` means the submission was refused.
2. The IDE then polls
   `GET /api/ide/submit?solution_id=<upid>` every 3–5 s while the result is
   pending.
   - The response has `result_code`, `upid` and `result_description` (the
     test case currently running), plus `time`, `mem` and `score`.
3. `result_code` values and the IDE's labels (code):

| `result_code`                                                              | Label                    | Our verdict                         |
| -------------------------------------------------------------------------- | ------------------------ | ----------------------------------- |
| `wait` (or missing/unknown)                                                | Submission Queued        | PENDING                             |
| `accepted`                                                                 | Correct Answer           | **ACCEPTED**                        |
| `partial_accepted`                                                         | Partially Correct Answer | REJECTED                            |
| `wrong`                                                                    | Wrong Answer             | REJECTED                            |
| `time`                                                                     | Time Limit Exceeded      | REJECTED                            |
| `runtime`                                                                  | Runtime Error            | REJECTED                            |
| `compile`                                                                  | Compilation Error        | REJECTED                            |
| `error`, `server_errors`, `judge_error`, `problem_error`, `score`, `limit` | errors                   | REJECTED (terminal, never uploaded) |

Only `accepted` uploads. Partial (subtask) acceptance does not count.

## Source code, problem and language (code)

- `GET /api/submission-code/<id>` → `{ data: { code } }`. The "My
  Submissions" panel uses this to load a past submission's code into the
  editor. It is keyed by the submission id, so the code belongs to that
  submission.
- `GET /api/contests/<contestCode>/problems/<problemCode>` →
  `{ status: "success", problem_name, ... }`, for the title.
- `GET /api/ide/<contestCode>/languages/<problemCode>` →
  `{ languages: [{ id, short_name, full_name }] }`, to map the submitted
  numeric `language` id to a name. `short_name` (e.g. `C++17`, `PYTH 3`) is
  used if the shared language table recognises it, otherwise `full_name`.
- `/viewsolution/<id>` is the human-readable submission page (not used).

## Detection in the extension

1. **Page-world hook** (`world: "MAIN"`, `document_start`). It observes
   (never modifies) XHR/fetch traffic:
   - For `POST /api/ide/submit` it relays `problemCode`, `contestCode`, the
     `language` id, the response, and the two header values above (needed
     for our own same-origin requests).
   - For `GET /api/ide/submit?solution_id=…` it relays the response body.
   - It never relays the source code.
2. **Isolated script.** It remembers each submit it saw (by `upid`). When a
   poll result for that `upid` says `accepted`, it fetches the code, problem
   and language as above and emits the event once.
   - Poll results for a `upid` this page did not submit are reported as
     verdicts only, never uploaded. That stops history browsing and forged
     messages from causing uploads.
   - The CSRF and IDE header values are held only in that page's memory. They
     are never stored, logged or sent to the extension or any other origin.

## Keys and slugs

- `problemKey` = problem code (`FLOW001`); `problemSlug` = `flow001-add-two-numbers`.
- `contest` = `{ id: contestCode, kind: "practice" | "contest" }`.
- `problemUrl` = `/problems/<code>` for practice, otherwise
  `/<contestCode>/problems/<code>`.
- `submittedAt` = when the submit request was observed (accurate, local clock).

## Limitations / to verify live

| Item                                                                     | Status                                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Exact JSON of `/api/submission-code/<id>` beyond `data.code`             | assumed                                                                  |
| Whether the GETs need `x-csrf-token`                                     | sent anyway when known                                                   |
| Reloading the page before the verdict arrives                            | not captured (no submit info); use force upload (stage 5)                |
| Submissions made outside the IDE page (e.g. old submit form, mobile app) | not captured                                                             |
| Assessment/skill-test and "lab" problems                                 | ignored (same endpoint, but `assessmentPreviewMode` submits are skipped) |
| Byte exactness                                                           | depends on what `submission-code` returns; compare per MANUAL_E2E        |
