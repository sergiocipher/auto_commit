# Manual end-to-end checklist

Automated tests run against a fake GitHub and synthetic platform payloads.
These steps check the real thing. Record the date, browser version and result
for each step; a platform can be labeled `verified` in the README only after
its section passes.

## 0. One-time setup

1. Create a **separate** solutions repository on GitHub with at least one
   commit (e.g. "Add a README"), so `main` exists. Do not use the project
   repository for solutions.
2. Create a GitHub OAuth App (Settings → Developer settings → OAuth Apps → New)
   and tick **Enable Device Flow**. Copy the Client ID; no client secret is needed.
3. `cp packages/extension/.env.example packages/extension/.env.local` and set
   `VITE_GITHUB_CLIENT_ID=<client id>`.
4. `npm install && npm -w @cst/extension run build`.
5. `chrome://extensions` → Developer mode → **Load unpacked** →
   `packages/extension/dist`.
6. Open the extension's **Settings** → **Connect GitHub** → allow the GitHub
   access prompt → open the shown URL, enter the code, approve.
   - [ ] Settings shows "Connected as <you>".
7. **Load my repositories** → choose the solutions repo and branch → **Save settings**.
   - [ ] The popup shows "Waiting for submission".

## LeetCode

Log in to leetcode.com in the same Chrome profile.

| #   | Step                                                                                                                    | Expected                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | Open a problem you have **not** solved today (e.g. _Two Sum_), submit a **wrong** answer.                               | Popup: "Waiting for submission", last verdict "Wrong Answer". Nothing new in the repo.                                                                                                                                        |
| L2  | Submit an **accepted** solution.                                                                                        | Popup goes "Submission accepted" → "Uploading to GitHub" → "Upload successful". Repo has `data/leetcode/two-sum/solution.<ext>` and `metadata.json` in **one** commit `feat(solutions): add LeetCode - Two Sum (<Language>)`. |
| L3  | Compare the file with your code byte for byte (download raw from GitHub; `diff` or `sha256sum`).                        | Identical, including trailing spaces, tabs and blank lines.                                                                                                                                                                   |
| L4  | Submit another accepted solution to the same problem (same day, default period).                                        | "Already uploaded during this period"; no new commit.                                                                                                                                                                         |
| L5  | Submit an accepted solution in a **different language**, same day.                                                      | Skipped (default policy).                                                                                                                                                                                                     |
| L6  | Next calendar day (in your configured timezone), submit accepted again with different code.                             | New commit; file `solution-<submissionId>.<ext>` (the original is untouched).                                                                                                                                                 |
| L7  | Reload the extension (chrome://extensions → ↻) **while** an upload is pending (e.g. right after "Submission accepted"). | After reload the upload completes; exactly one commit.                                                                                                                                                                        |
| L8  | Settings → **Disconnect GitHub**, then submit accepted on a new problem.                                                | "Needs GitHub reconnect". Reconnect → upload completes without resubmitting.                                                                                                                                                  |
| L9  | Open an old accepted submission page (`/problems/<slug>/submissions/<id>/`, older than 15 min).                         | Nothing uploaded.                                                                                                                                                                                                             |

### Capture real payloads (needed to move LeetCode to `verified`)

The adapter was written without access to the live site (see
[platforms/leetcode.md](platforms/leetcode.md)). While doing L1/L2:

1. Open DevTools → **Network**, filter `check`.
2. Submit. Confirm requests to `/submissions/detail/<id>/check/` appear, and
   save one pending and one final response (right-click → Copy response).
3. Filter `graphql`. On the submission page, find the request whose payload
   contains `submissionDetails` (or run the query from
   `platforms/leetcode.md` in the console with `fetch`), and copy the response.
4. **Sanitize before sharing or committing**: remove cookies, `csrftoken`,
   usernames and any personal data. Source code of your own solution is fine
   to keep.
5. Compare with `packages/extension/test/fixtures/leetcode/*.json`. Report any
   differences (field names, types, status codes) so the parser and fixtures
   can be corrected.
6. In the extension's service-worker console (chrome://extensions → _service
   worker_) and the page console, look for `[submission-tracker]` messages
   explaining any skipped capture.

## Codeforces

Log in to codeforces.com in the same Chrome profile. Pick an easy problem you
have not solved today (e.g. `4A`).

| #   | Step                                                                                           | Expected                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1  | Submit a **wrong** answer from the problem page; you land on `/contest/<id>/my`.               | Row goes "Running…" → "Wrong answer"; nothing uploaded.                                                                                                                                    |
| C2  | Submit an **accepted** solution and stay on the "my" page until judged.                        | Popup ends at "Upload successful"; repo has `data/codeforces/4a-watermelon/solution.<ext>` + `metadata.json` in one commit `feat(solutions): add Codeforces - 4A Watermelon (<Language>)`. |
| C3  | Compare the file with your code byte for byte.                                                 | Identical (including CRLF if you submitted from Windows).                                                                                                                                  |
| C4  | Reload the "my" page.                                                                          | Nothing new is uploaded (old accepted rows are history).                                                                                                                                   |
| C5  | Repeat C2 from `/problemset/problem/...`, a gym contest and (if you have one) a group contest. | Each uploads once into its own folder (`<contestId><index>-<title>`).                                                                                                                      |
| C6  | Open `/contest/<id>/status` while someone else's submission is judged Accepted.                | Nothing uploaded.                                                                                                                                                                          |
| C7  | Accepted again the same day for the same problem.                                              | "Already uploaded during this period".                                                                                                                                                     |

### Capture real markup (needed to move Codeforces to `verified`)

1. On `/contest/<id>/my`, right-click a row → **Inspect**, copy the `<tr>`
   outer HTML while judging and after "Accepted". Compare with
   `test/fixtures/codeforces/contest-my.html` (attributes `data-submission-id`,
   `waiting`, `submissionVerdict`, classes `verdict-*`).
2. DevTools → Network → click a submission ID (view-source popup) and look for
   `POST /data/submitSource`. Copy the response JSON and check it has `source`.
3. Sanitize (remove `csrf_token`, cookies, handles if desired) before sharing.
4. Look for `[submission-tracker]` messages in the page console if a capture
   was skipped.
