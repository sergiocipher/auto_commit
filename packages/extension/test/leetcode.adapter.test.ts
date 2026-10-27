import { describe, expect, it, vi } from "vitest";
import type { SubmissionEvent } from "@cst/shared";
import { createLeetCodeAdapter, type LeetCodeEnv } from "../src/adapters/leetcode/adapter.js";
import { LEETCODE_CHECK_CHANNEL } from "../src/adapters/leetcode/channel.js";
import type { ObservedVerdict } from "../src/adapters/types.js";
import { BRIDGE_TAG, postToIsolated } from "../src/content/bridge.js";
import { fakeWindow, flush } from "./fakeWindow.js";
import { fixture } from "./fixtures.js";

const lc = (name: string) => fixture("leetcode", name);
const NOW = 1_700_000_005_000;

function setup(
  opts: { href?: string; details?: unknown; titleFails?: boolean; now?: number } = {},
) {
  const win = fakeWindow(opts.href);
  const requests: {
    body: { query: string; variables: Record<string, unknown> };
    headers: Record<string, string>;
  }[] = [];
  const fetch = vi.fn<LeetCodeEnv["fetch"]>(async (_url, init) => {
    const body = JSON.parse(String(init.body));
    requests.push({ body, headers: init.headers as Record<string, string> });
    if (body.query.includes("submissionDetails"))
      return {
        ok: true,
        status: 200,
        json: async () => opts.details ?? lc("details-accepted.json"),
      };
    if (opts.titleFails) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => lc("question-title.json") };
  });
  const adapter = createLeetCodeAdapter({
    win,
    fetch,
    now: () => opts.now ?? NOW,
    csrfToken: () => "csrf123",
    urlPollMs: 5,
  });
  const verdicts: ObservedVerdict[] = [];
  const submissions: SubmissionEvent[] = [];
  const controller = new AbortController();
  adapter.start({
    signal: controller.signal,
    emitVerdict: (v) => verdicts.push(v),
    emitSubmission: (e) => submissions.push(e),
  });
  const check = (file: string, id = "1234567890") =>
    postToIsolated(win, LEETCODE_CHECK_CHANNEL, {
      url: `https://leetcode.com/submissions/detail/${id}/check/`,
      body: lc(file),
    });
  return { win, fetch, requests, verdicts, submissions, check, controller };
}

describe("LeetCode adapter", () => {
  it("captures an accepted submission from the relayed check", async () => {
    const t = setup();
    t.check("check-pending.json");
    t.check("check-accepted.json");
    await flush();
    expect(t.verdicts.map((v) => v.verdict)).toEqual(["PENDING", "ACCEPTED", "ACCEPTED"]);
    expect(t.submissions).toHaveLength(1);
    expect(t.submissions[0]).toMatchObject({
      submissionId: "1234567890",
      problemTitle: "Two Sum",
      language: "python3",
    });
    expect(t.requests[0]!.body.variables).toEqual({ submissionId: 1234567890 });
    expect(t.requests[0]!.headers["x-csrftoken"]).toBe("csrf123");
  });

  it.each([
    "check-wrong-answer.json",
    "check-compile-error.json",
    "check-runtime-error.json",
    "check-time-limit.json",
    "check-memory-limit.json",
    "check-pending.json",
  ])("never fetches source or emits for %s", async (file) => {
    const t = setup();
    t.check(file);
    await flush();
    expect(t.submissions).toEqual([]);
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.verdicts).toHaveLength(1);
  });

  it("fetches details only once for repeated accepted checks", async () => {
    const t = setup();
    t.check("check-accepted.json");
    t.check("check-accepted.json");
    t.check("check-accepted.json");
    await flush();
    expect(t.requests.filter((r) => r.body.query.includes("submissionDetails"))).toHaveLength(1);
    expect(t.submissions).toHaveLength(1);
  });

  it("ignores relays whose body is for a different submission than the URL", async () => {
    const t = setup();
    t.check("check-accepted.json", "999");
    await flush();
    expect(t.submissions).toEqual([]);
  });

  it("ignores forged messages from other origins or without the bridge envelope", async () => {
    const t = setup();
    const url = "https://leetcode.com/submissions/detail/1234567890/check/";
    t.win.dispatch(
      {
        tag: BRIDGE_TAG,
        channel: LEETCODE_CHECK_CHANNEL,
        payload: { url, body: lc("check-accepted.json") },
      },
      { origin: "https://evil.example" },
    );
    t.win.dispatch({
      channel: LEETCODE_CHECK_CHANNEL,
      payload: { url, body: lc("check-accepted.json") },
    });
    await flush();
    expect(t.fetch).not.toHaveBeenCalled();
  });

  it("does not emit when details say the submission was not accepted", async () => {
    const t = setup({ details: lc("details-wrong-answer.json") });
    t.check("check-accepted.json");
    await flush();
    expect(t.submissions).toEqual([]);
    expect(t.verdicts.at(-1)!.verdict).toBe("REJECTED");
  });

  it("does not emit when logged out (details unavailable)", async () => {
    const t = setup({ details: lc("details-missing.json") });
    t.check("check-accepted.json");
    await flush();
    expect(t.submissions).toEqual([]);
  });

  it("still uploads without a title when the title query fails", async () => {
    const t = setup({ titleFails: true });
    t.check("check-accepted.json");
    await flush();
    expect(t.submissions[0]!.problemTitle).toBe("");
  });

  it("refuses when the page shows a different problem", async () => {
    const t = setup({ href: "https://leetcode.com/problems/add-two-numbers/" });
    t.check("check-accepted.json");
    await flush();
    expect(t.submissions).toEqual([]);
  });

  it("captures a fresh submission from its page URL (SPA fallback)", async () => {
    const t = setup({ href: "https://leetcode.com/problems/two-sum/submissions/1234567890/" });
    await flush();
    expect(t.submissions).toHaveLength(1);
  });

  it("ignores old submissions when just browsing history", async () => {
    const t = setup({
      href: "https://leetcode.com/problems/two-sum/submissions/1234567890/",
      now: 1_700_000_000_000 + 16 * 60_000,
    });
    await flush();
    expect(t.submissions).toEqual([]);
  });

  it("follows SPA navigation", async () => {
    const t = setup();
    await flush();
    expect(t.fetch).not.toHaveBeenCalled();
    t.win.location.href = "https://leetcode.com/problems/two-sum/submissions/1234567890/";
    await new Promise((r) => setTimeout(r, 20));
    await flush();
    expect(t.submissions).toHaveLength(1);
  });

  it("stops after abort", async () => {
    const t = setup();
    t.controller.abort();
    t.check("check-accepted.json");
    await flush();
    expect(t.fetch).not.toHaveBeenCalled();
  });

  it("only handles leetcode.com", () => {
    const adapter = createLeetCodeAdapter({
      win: fakeWindow(),
      fetch: vi.fn(),
      now: () => 0,
      csrfToken: () => undefined,
    });
    expect(adapter.canHandle("https://leetcode.com/problems/two-sum/")).toBe(true);
    expect(adapter.canHandle("https://leetcode.cn/problems/two-sum/")).toBe(false);
    expect(adapter.canHandle("https://leetcode.com.evil.example/")).toBe(false);
  });
});
