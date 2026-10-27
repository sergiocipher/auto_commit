import { describe, expect, it } from "vitest";
import { createLeetCodeAdapter } from "../src/adapters/leetcode/adapter.js";
import { LEETCODE_CHECK_CHANNEL } from "../src/adapters/leetcode/channel.js";
import { postToIsolated } from "../src/content/bridge.js";
import { runAdapter } from "../src/content/runner.js";
import { deriveStatus } from "../src/ui/status.js";
import { fakeWindow, flush } from "./fakeWindow.js";
import { fixture } from "./fixtures.js";
import { createPipeline } from "./pipeline.js";

const lc = (name: string) => fixture("leetcode", name) as Record<string, unknown>;

/** Builds details/check fixtures for another submission of the same or another problem. */
function variant(id: string, opts: { code?: string; lang?: string; timestamp?: number } = {}) {
  const details = structuredClone(lc("details-accepted.json")) as {
    data: { submissionDetails: Record<string, unknown> };
  };
  const d = details.data.submissionDetails;
  if (opts.code) d.code = opts.code;
  if (opts.lang) d.lang = { name: opts.lang, verboseName: opts.lang };
  if (opts.timestamp) d.timestamp = opts.timestamp;
  const check = { ...lc("check-accepted.json"), submission_id: id, lang: opts.lang ?? "python3" };
  return { details, check };
}

async function setup() {
  const p = await createPipeline();
  // One "tab" on a LeetCode problem page with the real adapter and runner.
  let details: unknown = lc("details-accepted.json");
  const win = fakeWindow("https://leetcode.com/problems/two-sum/");
  const adapter = createLeetCodeAdapter({
    win,
    fetch: async (_url, init) => {
      const q = JSON.parse(String(init.body)).query as string;
      return {
        ok: true,
        status: 200,
        json: async () => (q.includes("submissionDetails") ? details : lc("question-title.json")),
      };
    },
    now: p.now,
    csrfToken: () => undefined,
    urlPollMs: 60_000,
  });
  runAdapter(
    adapter,
    win.location.href,
    p.sender("https://leetcode.com/problems/two-sum/"),
    new AbortController().signal,
  );

  const submit = async (id: string, check: unknown, d: unknown) => {
    details = d;
    postToIsolated(win, LEETCODE_CHECK_CHANNEL, {
      url: `https://leetcode.com/submissions/detail/${id}/check/`,
      body: check,
    });
    await flush(20);
    await p.settle();
  };
  return { gh: p.gh, activity: p.activity, jobs: p.jobs, submit, advance: p.advance };
}

describe("LeetCode -> GitHub (mocked GitHub, synthetic LeetCode payloads)", () => {
  it("uploads an accepted submission byte-exactly with the right commit", async () => {
    const t = await setup();
    await t.submit("1234567890", lc("check-accepted.json"), lc("details-accepted.json"));
    const code = (lc("details-accepted.json") as { data: { submissionDetails: { code: string } } })
      .data.submissionDetails.code;
    expect(t.gh.readFile("data/leetcode/two-sum/solution.py")).toBe(code);
    expect(t.gh.log()).toEqual([
      "feat(solutions): add LeetCode - Two Sum (Python)",
      "Initial commit",
    ]);
    const latest = (await t.activity.list())[0];
    expect(latest).toMatchObject({ status: "SUCCESS", commitSha: t.gh.head() });
    expect(deriveStatus(latest)).toBe("success");
  });

  it("does not upload a wrong answer", async () => {
    const t = await setup();
    await t.submit(
      "1",
      { ...lc("check-wrong-answer.json"), submission_id: "1" },
      lc("details-wrong-answer.json"),
    );
    expect(t.gh.log()).toEqual(["Initial commit"]);
    expect(deriveStatus((await t.activity.list())[0])).toBe("waiting");
  });

  it("skips a second accepted solution the same day, uploads again the next day", async () => {
    const t = await setup();
    await t.submit("1234567890", lc("check-accepted.json"), lc("details-accepted.json"));
    const again = variant("1234567891", { code: "print('v2')\n" });
    await t.submit("1234567891", again.check, again.details);
    expect(t.gh.log()).toHaveLength(2);
    expect(deriveStatus((await t.activity.list())[0])).toBe("alreadyUploaded");

    t.advance(24 * 3_600_000);
    const tomorrow = variant("1234567892", {
      code: "print('v3')\n",
      timestamp: 1_700_000_000 + 86_400,
    });
    await t.submit("1234567892", tomorrow.check, tomorrow.details);
    expect(t.gh.log()).toHaveLength(3);
    expect(t.gh.readFile("data/leetcode/two-sum/solution-1234567892.py")).toBe("print('v3')\n");
    expect(t.gh.readFile("data/leetcode/two-sum/solution.py")).not.toBe("print('v3')\n"); // never overwritten
  });

  it("re-emitted events for one submission produce one commit", async () => {
    const t = await setup();
    for (let i = 0; i < 3; i++)
      await t.submit("1234567890", lc("check-accepted.json"), lc("details-accepted.json"));
    expect(t.gh.log()).toHaveLength(2);
    expect(await t.jobs.list()).toHaveLength(1);
  });
});
