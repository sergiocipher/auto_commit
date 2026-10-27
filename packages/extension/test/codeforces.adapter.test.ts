// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SubmissionEvent } from "@cst/shared";
import { createCodeforcesAdapter, type CodeforcesEnv } from "../src/adapters/codeforces/adapter.js";
import type { ObservedVerdict } from "../src/adapters/types.js";

const raw = (name: string) =>
  readFileSync(resolve(import.meta.dirname, "fixtures/codeforces", name), "utf8");
const EXPECTED = raw("expected-source.txt");
const cells = new DOMParser()
  .parseFromString(raw("verdict-cells.html"), "text/html")
  .querySelectorAll("td.status-verdict-cell");
const CELL = { testing: 0, accepted: 2, wa: 3, ce: 7 } as const;

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

function setup(
  opts: {
    page?: string;
    html?: string;
    referrer?: string;
    submitSource?: "ok" | "fail" | "none";
    pageFetch?: "ok" | "fail";
  } = {},
) {
  const doc = new DOMParser().parseFromString(
    opts.html ?? raw(opts.page ?? "contest-my.html"),
    "text/html",
  );
  if (opts.submitSource === "none") doc.querySelector('meta[name="X-Csrf-Token"]')?.remove();
  let now = 1_000_000;
  const fetch = vi.fn<CodeforcesEnv["fetch"]>(async (url, init) => {
    if (url.endsWith("/data/submitSource")) {
      expect(String(init?.body)).toContain("csrf_token=csrf-synthetic-0000");
      return opts.submitSource === "fail"
        ? { ok: false, status: 403, text: async () => "" }
        : { ok: true, status: 200, text: async () => raw("submit-source.json") };
    }
    return opts.pageFetch === "fail"
      ? { ok: false, status: 500, text: async () => "" }
      : { ok: true, status: 200, text: async () => raw("submission-page.html") };
  });
  let trigger = () => {};
  const verdicts: ObservedVerdict[] = [];
  const submissions: SubmissionEvent[] = [];
  const controller = new AbortController();
  const adapter = createCodeforcesAdapter({
    doc,
    fetch,
    now: () => now,
    referrer: opts.referrer ?? "",
    observe: (onChange) => {
      trigger = onChange;
    },
  });
  adapter.start({
    signal: controller.signal,
    emitVerdict: (v) => verdicts.push(v),
    emitSubmission: (e) => submissions.push(e),
  });
  /** Simulates Codeforces' live update of one row's verdict cell. */
  const judge = async (submissionId: string, cell: keyof typeof CELL, advanceMs = 5000) => {
    now += advanceMs;
    const td = doc.querySelector(
      `tr[data-submission-id="${submissionId}"] td.status-verdict-cell`,
    )!;
    td.replaceWith(cells[CELL[cell]]!.cloneNode(true));
    trigger();
    await flush();
  };
  return { doc, fetch, verdicts, submissions, judge, trigger, controller };
}

describe("Codeforces adapter", () => {
  it("captures a submission judged Accepted while watching, with exact source", async () => {
    const t = setup();
    await t.judge("300000003", "accepted");
    expect(t.submissions).toHaveLength(1);
    expect(t.submissions[0]).toMatchObject({
      submissionId: "300000003",
      problemKey: "4A",
      submittedAt: 1_000_000,
      detectedAt: 1_005_000,
    });
    expect(t.submissions[0]!.sourceCode).toBe(EXPECTED);
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });

  it("never uploads accepted rows that were already on the page (history)", async () => {
    const t = setup();
    t.trigger();
    await flush();
    expect(t.submissions).toEqual([]);
    expect(t.verdicts.find((v) => v.submissionId === "200000001")?.verdict).toBe("ACCEPTED");
    expect(t.fetch).not.toHaveBeenCalled();
  });

  it.each(["wa", "ce"] as const)("does not upload a %s verdict", async (cell) => {
    const t = setup();
    await t.judge("300000003", cell);
    expect(t.submissions).toEqual([]);
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.verdicts.filter((v) => v.submissionId === "300000003").map((v) => v.verdict)).toEqual([
      "PENDING",
      "REJECTED",
    ]);
  });

  it("ignores other users' submissions on a contest status page", async () => {
    const t = setup({ page: "contest-status-others.html" });
    await t.judge("300000010", "accepted");
    expect(t.submissions).toEqual([]);
    expect(t.verdicts).toEqual([]);
  });

  it("does nothing when logged out", async () => {
    const t = setup({ page: "logged-out.html" });
    t.trigger();
    await flush();
    expect(t.verdicts).toEqual([]);
  });

  it("captures the newest own row once when arriving right after submitting", async () => {
    const t = setup({
      page: "contest-my.html",
      referrer: "https://codeforces.com/contest/1/submit",
    });
    // Here the first own row is pending, so nothing yet; once judged it is captured as usual.
    await t.judge("300000003", "accepted");
    expect(t.submissions.map((s) => s.submissionId)).toEqual(["300000003"]);
    // The older accepted row (200000001) is never captured.
    expect(t.fetch).toHaveBeenCalledTimes(1);
  });

  it("captures an already-judged newest row only after a submit redirect", async () => {
    // Fast judging: the row is already Accepted when the page loads.
    const html = raw("contest-my.html").replace(
      /(<tr data-submission-id="300000003">[\s\S]*?)<td class="status-cell status-small status-verdict-cell"[\s\S]*?<\/td>/,
      (_m, head: string) => head + cells[CELL.accepted]!.outerHTML,
    );
    const fromSubmit = setup({ html, referrer: "https://codeforces.com/contest/4/submit" });
    await flush();
    expect(fromSubmit.submissions.map((e) => e.submissionId)).toEqual(["300000003"]);
    expect(fromSubmit.fetch).toHaveBeenCalledTimes(1); // the older accepted row is not captured

    const browsing = setup({ html, referrer: "https://codeforces.com/contest/4/my" });
    await flush();
    expect(browsing.submissions).toEqual([]);
  });

  it("falls back to the submission page when submitSource fails, still byte-exact", async () => {
    const t = setup({ submitSource: "fail" });
    await t.judge("300000003", "accepted");
    expect(t.fetch.mock.calls.map((c) => c[0])).toEqual([
      "https://codeforces.com/data/submitSource",
      "https://codeforces.com/contest/4/submission/300000003",
    ]);
    expect(t.submissions[0]!.sourceCode).toBe(EXPECTED);
  });

  it("uses the submission page directly without a CSRF token", async () => {
    const t = setup({ submitSource: "none" });
    await t.judge("300000003", "accepted");
    expect(t.fetch.mock.calls.map((c) => c[0])).toEqual([
      "https://codeforces.com/contest/4/submission/300000003",
    ]);
    expect(t.submissions).toHaveLength(1);
  });

  it("emits nothing if no source can be retrieved, and retries on the next update", async () => {
    const t = setup({ submitSource: "fail", pageFetch: "fail" });
    await t.judge("300000003", "accepted");
    expect(t.submissions).toEqual([]);
    t.trigger();
    await flush();
    expect(t.fetch).toHaveBeenCalledTimes(4);
  });

  it("captures once despite repeated DOM updates", async () => {
    const t = setup();
    await t.judge("300000003", "accepted");
    t.trigger();
    t.trigger();
    await flush();
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.submissions).toHaveLength(1);
  });

  it.each([
    ["problemset-status.html", "300000020", "4A", "4a-watermelon"],
    ["gym-my.html", "300000030", "100001A", "100001a-gym-warmup"],
    ["group-my.html", "300000040", "345678C", "345678c-group-task"],
  ])("handles %s", async (page, id, key, slug) => {
    const t = setup({ page });
    await t.judge(id, "accepted");
    expect(t.submissions[0]).toMatchObject({
      submissionId: id,
      problemKey: key,
      problemSlug: slug,
    });
  });

  it("stops after abort", async () => {
    const t = setup();
    t.controller.abort();
    await t.judge("300000003", "accepted");
    expect(t.submissions).toEqual([]);
  });
});
