import { describe, expect, it, vi } from "vitest";
import type { SubmissionEvent } from "@cst/shared";
import { createCodeChefAdapter, type CodeChefEnv } from "../src/adapters/codechef/adapter.js";
import {
  CODECHEF_RESULT_CHANNEL,
  CODECHEF_SUBMIT_CHANNEL,
} from "../src/adapters/codechef/channel.js";
import type { ObservedVerdict } from "../src/adapters/types.js";
import { postToIsolated } from "../src/content/bridge.js";
import { fakeWindow, flush } from "./fakeWindow.js";
import { fixture } from "./fixtures.js";

const cc = (name: string) => fixture("codechef", name);
const RESULT_URL = "https://www.codechef.com/api/ide/submit?solution_id=1100223344";

function setup(opts: { codeFails?: boolean; titleFails?: boolean; langFails?: boolean } = {}) {
  const win = fakeWindow("https://www.codechef.com/problems/FLOW001");
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const fetch = vi.fn<CodeChefEnv["fetch"]>(async (url, init) => {
    requests.push({ url, headers: init.headers as Record<string, string> });
    const fail = { ok: false, status: 500, json: async () => ({}) };
    if (url.includes("/api/submission-code/"))
      return opts.codeFails
        ? fail
        : { ok: true, status: 200, json: async () => cc("submission-code.json") };
    if (url.includes("/api/contests/"))
      return opts.titleFails
        ? fail
        : { ok: true, status: 200, json: async () => cc("problem.json") };
    if (url.includes("/languages/"))
      return opts.langFails
        ? fail
        : { ok: true, status: 200, json: async () => cc("languages.json") };
    return fail;
  });
  let now = 5_000;
  const verdicts: ObservedVerdict[] = [];
  const submissions: SubmissionEvent[] = [];
  const controller = new AbortController();
  createCodeChefAdapter({ win, fetch, now: () => now }).start({
    signal: controller.signal,
    emitVerdict: (v) => verdicts.push(v),
    emitSubmission: (e) => submissions.push(e),
  });
  const submit = (overrides: Record<string, unknown> = {}) => {
    postToIsolated(win, CODECHEF_SUBMIT_CHANNEL, {
      problemCode: "FLOW001",
      contestCode: "PRACTICE",
      languageId: "63",
      response: cc("submit-response.json"),
      csrfToken: "csrf-synthetic",
      ideKey: "ide-synthetic",
      ...overrides,
    });
    return flush();
  };
  const result = async (file: string, url = RESULT_URL) => {
    now += 3000;
    postToIsolated(win, CODECHEF_RESULT_CHANNEL, { url, body: cc(file) });
    await flush();
  };
  return { win, fetch, requests, verdicts, submissions, submit, result, controller };
}

describe("CodeChef adapter", () => {
  it("captures a submission from this page once it is accepted", async () => {
    const t = setup();
    await t.submit();
    await t.result("result-wait.json");
    expect(t.submissions).toEqual([]);
    await t.result("result-accepted.json");
    expect(t.submissions).toHaveLength(1);
    expect(t.submissions[0]).toMatchObject({
      submissionId: "1100223344",
      problemKey: "FLOW001",
      problemTitle: "Add Two Numbers",
      language: "C++17",
      submittedAt: 5000,
    });
    expect(t.verdicts.map((v) => v.verdict)).toEqual(["PENDING", "PENDING", "ACCEPTED"]);
  });

  it("sends CodeChef's own headers on same-origin requests", async () => {
    const t = setup();
    await t.submit();
    await t.result("result-accepted.json");
    const code = t.requests.find((r) => r.url.includes("submission-code"))!;
    expect(code.url).toBe("https://www.codechef.com/api/submission-code/1100223344");
    expect(code.headers).toMatchObject({
      "X-Requested-With": "XMLHttpRequest",
      "x-csrf-token": "csrf-synthetic",
    });
    expect(code.headers["x-cc-ide-key"]).toBeUndefined();
    const langs = t.requests.find((r) => r.url.includes("/languages/"))!;
    expect(langs.url).toBe("https://www.codechef.com/api/ide/PRACTICE/languages/FLOW001");
    expect(langs.headers["x-cc-ide-key"]).toBe("ide-synthetic");
  });

  it.each([
    "result-wrong.json",
    "result-partial_accepted.json",
    "result-compile.json",
    "result-time.json",
    "result-runtime.json",
    "result-error.json",
  ])("never fetches source for %s", async (file) => {
    const t = setup();
    await t.submit();
    await t.result(file);
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.submissions).toEqual([]);
  });

  it("never uploads a result for a submission this page did not make", async () => {
    const t = setup();
    await t.result("result-accepted.json");
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.verdicts.at(-1)!.verdict).toBe("ACCEPTED"); // still shown in the popup
  });

  it("ignores refused submits, bad codes and mismatched result bodies", async () => {
    const t = setup();
    await t.submit({ response: cc("submit-refused.json") });
    await t.submit({ problemCode: "../x" });
    await t.submit({ languageId: "abc" });
    await t.result("result-accepted.json");
    expect(t.fetch).not.toHaveBeenCalled();

    const u = setup();
    await u.submit();
    await u.result(
      "result-accepted.json",
      "https://www.codechef.com/api/ide/submit?solution_id=999",
    );
    expect(u.fetch).not.toHaveBeenCalled();
  });

  it("captures once despite repeated accepted results", async () => {
    const t = setup();
    await t.submit();
    await t.result("result-accepted.json");
    await t.result("result-accepted.json");
    expect(t.requests.filter((r) => r.url.includes("submission-code"))).toHaveLength(1);
    expect(t.submissions).toHaveLength(1);
  });

  it("emits nothing when the code cannot be fetched (logged out)", async () => {
    const t = setup({ codeFails: true });
    await t.submit();
    await t.result("result-accepted.json");
    expect(t.submissions).toEqual([]);
  });

  it("still emits without a title or a language name", async () => {
    const t = setup({ titleFails: true, langFails: true });
    await t.submit();
    await t.result("result-accepted.json");
    expect(t.submissions[0]).toMatchObject({
      problemTitle: "",
      language: "CodeChef language 63",
      problemSlug: "flow001",
    });
  });

  it("rejects relays with unknown fields (e.g. smuggled source code)", async () => {
    const t = setup();
    await t.submit({ sourceCode: "evil" });
    await t.result("result-accepted.json");
    expect(t.fetch).not.toHaveBeenCalled();
  });

  it("stops after abort", async () => {
    const t = setup();
    await t.submit();
    t.controller.abort();
    await t.result("result-accepted.json");
    expect(t.fetch).not.toHaveBeenCalled();
  });
});
