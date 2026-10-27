import { describe, expect, it } from "vitest";
import { resolveLanguage, sha256Hex } from "@cst/shared";
import {
  buildEvent,
  normalizeVerdict,
  parseCheck,
  parseDetails,
  parseTitle,
  submissionFromPageUrl,
  submissionIdFromCheckUrl,
  titleSlugFromUrl,
} from "../src/adapters/leetcode/parse.js";
import { fixture } from "./fixtures.js";

const lc = (name: string) => fixture("leetcode", name);

describe("LeetCode verdicts", () => {
  it.each([
    ["check-pending.json", "PENDING", false],
    ["check-started.json", "PENDING", false],
    ["check-accepted.json", "ACCEPTED", true],
    ["check-wrong-answer.json", "REJECTED", true],
    ["check-compile-error.json", "REJECTED", true],
    ["check-runtime-error.json", "REJECTED", true],
    ["check-time-limit.json", "REJECTED", true],
    ["check-memory-limit.json", "REJECTED", true],
  ])("%s -> %s", (file, verdict, final) => {
    expect(normalizeVerdict(lc(file))).toBe(verdict);
    expect(parseCheck(lc(file))).toMatchObject({ verdict, final });
  });

  it("requires both status code 10 and an Accepted message", () => {
    expect(
      normalizeVerdict({ state: "SUCCESS", status_code: 10, status_msg: "Wrong Answer" }),
    ).toBe("REJECTED");
    expect(normalizeVerdict({ state: "SUCCESS", status_code: 11, status_msg: "Accepted" })).toBe(
      "REJECTED",
    );
    expect(normalizeVerdict({ state: "STARTED", status_code: 10, status_msg: "Accepted" })).toBe(
      "PENDING",
    );
    expect(normalizeVerdict(null)).toBe("PENDING");
    expect(normalizeVerdict("Accepted")).toBe("PENDING");
  });

  it("extracts facts from an accepted check", () => {
    expect(parseCheck(lc("check-accepted.json"))).toEqual({
      final: true,
      verdict: "ACCEPTED",
      rawVerdict: "Accepted",
      submissionId: "1234567890",
      lang: "python3",
      questionId: "1",
      finishedAt: 1700000000123,
    });
  });
});

describe("LeetCode URLs", () => {
  it("parses check, submission and problem URLs", () => {
    expect(
      submissionIdFromCheckUrl("https://leetcode.com/submissions/detail/1234567890/check/"),
    ).toBe("1234567890");
    expect(submissionIdFromCheckUrl("/submissions/detail/42/check/")).toBe("42");
    expect(
      submissionIdFromCheckUrl("https://evil.example/submissions/detail/42/check/"),
    ).toBeNull();
    expect(
      submissionFromPageUrl("https://leetcode.com/problems/two-sum/submissions/1234567890/"),
    ).toEqual({
      titleSlug: "two-sum",
      submissionId: "1234567890",
    });
    expect(submissionFromPageUrl("https://leetcode.com/problems/two-sum/submissions/")).toBeNull();
    expect(titleSlugFromUrl("https://leetcode.com/problems/two-sum/description/")).toBe("two-sum");
    expect(titleSlugFromUrl("https://leetcode.com/problemset/")).toBeNull();
  });
});

describe("LeetCode details -> event", () => {
  it("builds an exact event from accepted details", async () => {
    const details = parseDetails(lc("details-accepted.json"), "1234567890");
    const title = parseTitle(lc("question-title.json"));
    const event = await buildEvent(details, {
      pageTitleSlug: "two-sum",
      check: parseCheck(lc("check-accepted.json")),
      title,
      detectedAt: 1700000001000,
    });
    const rawCode = (
      lc("details-accepted.json") as { data: { submissionDetails: { code: string } } }
    ).data.submissionDetails.code;
    expect(event).toEqual({
      platform: "leetcode",
      problemKey: "two-sum",
      problemSlug: "two-sum",
      problemId: "1",
      problemTitle: "Two Sum",
      problemUrl: "https://leetcode.com/problems/two-sum/",
      submissionId: "1234567890",
      language: "python3",
      languageNormalized: "python",
      sourceCode: rawCode,
      sourceSha256: await sha256Hex(rawCode),
      verdict: "ACCEPTED",
      submittedAt: 1700000000000,
      detectedAt: 1700000001000,
    });
    // CRLF, tab, trailing spaces and non-ASCII survive untouched.
    expect(event.sourceCode).toContain("\r\n\t");
    expect(event.sourceCode).toContain("List[int]:  \n");
    expect(event.sourceCode).toContain("café ✓");
    expect(resolveLanguage(event.language).extension).toBe("py");
  });

  it("refuses non-accepted, empty, mismatched or missing details", async () => {
    const ok = parseDetails(lc("details-accepted.json"), "1");
    await expect(
      buildEvent(parseDetails(lc("details-wrong-answer.json"), "1"), { detectedAt: 0 }),
    ).rejects.toThrow(/not accepted/);
    await expect(buildEvent({ ...ok, code: "" }, { detectedAt: 0 })).rejects.toThrow(
      /no source code/,
    );
    await expect(
      buildEvent(ok, { pageTitleSlug: "add-two-numbers", detectedAt: 0 }),
    ).rejects.toThrow(/different problem/);
    await expect(buildEvent(ok, { check: { questionId: "2" }, detectedAt: 0 })).rejects.toThrow(
      /do not match/,
    );
    await expect(buildEvent(ok, { check: { lang: "cpp" }, detectedAt: 0 })).rejects.toThrow(
      /language does not match/,
    );
    expect(() => parseDetails(lc("details-missing.json"), "1")).toThrow(/unavailable/);
    expect(() => parseDetails({ data: {} }, "1")).toThrow(/Unrecognized/);
  });

  it("falls back to an empty title (commit says Unknown Problem) when the title query fails", async () => {
    const event = await buildEvent(parseDetails(lc("details-accepted.json"), "1"), {
      title: null,
      detectedAt: 0,
    });
    expect(event.problemTitle).toBe("");
    expect(event.problemKey).toBe("two-sum");
  });

  it("accepts string timestamps", () => {
    const raw = structuredClone(lc("details-accepted.json")) as {
      data: { submissionDetails: { timestamp: unknown } };
    };
    raw.data.submissionDetails.timestamp = "1700000000";
    expect(parseDetails(raw, "1").submittedAt).toBe(1700000000000);
  });

  it.each([
    ["cpp", "cpp"],
    ["java", "java"],
    ["python", "py"],
    ["python3", "py"],
    ["c", "c"],
    ["csharp", "cs"],
    ["javascript", "js"],
    ["typescript", "ts"],
    ["golang", "go"],
    ["rust", "rs"],
    ["kotlin", "kt"],
    ["swift", "swift"],
    ["ruby", "rb"],
    ["php", "php"],
    ["scala", "scala"],
    ["mysql", "sql"],
  ])("LeetCode language %s -> .%s", (lang, ext) => {
    expect(resolveLanguage(lang).extension).toBe(ext);
  });
});
