# LeetCode adapter

**Status: implemented, unverified.** Investigated 2026-10-27. Nothing here has been
observed against the live site yet.

## What could and could not be checked

- From the development environment, `https://leetcode.com` answers plain HTTP
  clients with **403** (bot protection), and there is no logged-in session.
  Disguising requests to get past the bot check was deliberately not attempted.
- So the endpoints and payload shapes below are the **best-known behavior**
  (LeetCode's public web client as widely documented), not recorded traffic.
  The fixtures in `packages/extension/test/fixtures/leetcode/` are **synthetic**
  (`"_synthetic": true`), hand-built to those shapes. They contain no personal data.
- Confirm or correct these assumptions with the steps in
  [MANUAL_E2E.md](../MANUAL_E2E.md#leetcode) ("Capture real payloads").

## How a verdict arrives (hypothesis)

1. Submitting POSTs `/problems/<titleSlug>/submit/` and returns `{"submission_id": <n>}`.
2. The page polls `GET /submissions/detail/<id>/check/`:
   - while judging: `{"state": "PENDING"}` or `{"state": "STARTED"}`
   - when done: `{"state": "SUCCESS", "status_code": <n>, "status_msg": "...", "lang": "python3",
"question_id": "1", "submission_id": "<id>", "task_finish_time": <ms>, ...}`
3. Status codes: `10` Accepted, `11` Wrong Answer, `12` Memory Limit Exceeded,
   `13` Output Limit Exceeded, `14` Time Limit Exceeded, `15` Runtime Error,
   `16` Internal Error, `20` Compile Error.
4. After submitting, the URL becomes `/problems/<titleSlug>/submissions/<id>/` (SPA navigation).

**Accepted rule used:** `state == "SUCCESS"` and `status_code == 10`, and
`status_msg`, if present, equals `Accepted`. Anything with `state != "SUCCESS"`
is `PENDING`; every other final result is `REJECTED`.

## How the source code is obtained (hypothesis)

The page's `/check/` payload has no source code. After an Accepted check, the
isolated content script fetches the details **same-origin with the user's own
session** (content-script fetches use the page's origin and cookies):

```graphql
query submissionDetails($submissionId: Int!) {
  submissionDetails(submissionId: $submissionId) {
    code
    timestamp # seconds; string or number
    statusCode
    lang {
      name
      verboseName
    }
    question {
      questionId
      titleSlug
    }
  }
}
```

The title comes from a second, public query, so a schema change there only
loses the title (falling back to "Unknown Problem"), never the upload:

```graphql
query questionTitle($titleSlug: String!) {
  question(titleSlug: $titleSlug) {
    questionId
    questionFrontendId
    title
    titleSlug
  }
}
```

The `x-csrftoken` header is sent from the `csrftoken` cookie when present.

### Cross-checks before an event is emitted

- The details `statusCode` must be `10`.
- `code` must be non-empty. It is used exactly as returned: no trimming or
  newline changes. SHA-256 is computed over it.
- `question.titleSlug` must match the slug in the page URL, when the URL has one.
- When both are known, `question.questionId` must equal the `/check/` `question_id`.
- When both are known, `lang.name` must equal the `/check/` `lang`.
- The service worker then re-validates the event: schema, ACCEPTED, platform
  matches the sending tab, and the hash is recomputed.

## Detection paths in the extension

1. **Network hook (primary).** A `world: "MAIN"` content script at
   `document_start` wraps `fetch` and `XMLHttpRequest`. It forwards only
   `/submissions/detail/<id>/check/` response bodies to the isolated script via
   `window.postMessage`, where they are validated for source window, origin,
   envelope tag, channel and shape. The hook never modifies responses, and any
   error inside it is swallowed so the page keeps working.
2. **URL watcher (fallback).** If the page lands on
   `/problems/<slug>/submissions/<id>/`, the details are fetched directly. To
   avoid uploading old solutions while browsing history, this path only emits
   when the submission is **at most 15 minutes old**.

Page-world messages are untrusted (any script on leetcode.com can post them),
which is why source code always comes from the authenticated details fetch,
keyed by submission ID, never from the page message itself.

## Keys and slugs

- `problemKey` = `titleSlug` (e.g. `two-sum`). It is stable and used for dedup.
- `problemSlug` = the sanitized `titleSlug`, so the folder is `data/leetcode/two-sum/`.
- `problemId` = `questionFrontendId` when known (the number shown on the site),
  otherwise `questionId`.
- `language` = the raw `lang.name` (`cpp`, `python3`, `java`, `golang`, ...),
  mapped by `@cst/shared`'s language table.

## Failure modes and limitations

| Situation                            | Behavior                                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Logged out / session expired         | Details query fails; no event; nothing uploaded.                                                                        |
| GraphQL schema change                | Details parse fails with a logged reason; no upload. Title-query failure only loses the title.                          |
| Check-endpoint path change           | Network hook misses it; URL watcher still catches fresh submissions if the URL shape is unchanged.                      |
| Contest submissions (`/contest/...`) | Not handled in this stage.                                                                                              |
| leetcode.cn                          | Not supported (different host and API).                                                                                 |
| Rate limiting (429)                  | The details fetch is not retried automatically; the submission page fallback will try again on revisit (within 15 min). |
