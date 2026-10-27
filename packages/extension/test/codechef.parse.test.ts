import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveLanguage, sha256Hex } from "@cst/shared";
import {
  buildEvent,
  languageName,
  normalizeVerdict,
  parseProblemTitle,
  parseResult,
  parseSubmissionCode,
  parseSubmitResponse,
  problemUrl,
  solutionIdFromResultUrl,
} from "../src/adapters/codechef/parse.js";
import { fixture } from "./fixtures.js";

const cc = (name: string) => fixture("codechef", name);
const EXPECTED = readFileSync(
  resolve(import.meta.dirname, "fixtures/codechef/expected-source.txt"),
  "utf8",
);

describe("CodeChef verdicts", () => {
  it.each([
    ["result-wait.json", "PENDING", "Submission Queued"],
    ["result-accepted.json", "ACCEPTED", "Correct Answer"],
    ["result-partial_accepted.json", "REJECTED", "Partially Correct Answer"],
    ["result-wrong.json", "REJECTED", "Wrong Answer"],
    ["result-time.json", "REJECTED", "Time Limit Exceeded"],
    ["result-runtime.json", "REJECTED", "Runtime Error"],
    ["result-compile.json", "REJECTED", "Compilation Error"],
    ["result-error.json", "REJECTED", "error"],
    ["result-judge_error.json", "REJECTED", "judge_error"],
  ])("%s -> %s", (file, verdict, label) => {
    expect(normalizeVerdict(cc(file))).toBe(verdict);
    expect(parseResult(cc(file))).toEqual({ verdict, rawVerdict: label, upid: "1100223344" });
  });

  it("treats missing or unknown codes as still pending, never accepted", () => {
    expect(normalizeVerdict({})).toBe("PENDING");
    expect(normalizeVerdict({ result_code: "accepted_v2" })).toBe("PENDING");
    expect(normalizeVerdict({ result_code: "Accepted" })).toBe("PENDING");
    expect(normalizeVerdict(null)).toBe("PENDING");
  });
});

describe("CodeChef requests and responses", () => {
  it("reads the submission id from the submit response", () => {
    expect(parseSubmitResponse(cc("submit-response.json"))).toBe("1100223344");
    expect(parseSubmitResponse(cc("submit-refused.json"))).toBeNull();
    expect(parseSubmitResponse({ upid: "../1" })).toBeNull();
  });

  it("reads solution ids only from CodeChef result URLs", () => {
    expect(
      solutionIdFromResultUrl("https://www.codechef.com/api/ide/submit?solution_id=1100223344"),
    ).toBe("1100223344");
    expect(solutionIdFromResultUrl("https://codechef.com/api/ide/submit/?solution_id=1")).toBe("1");
    expect(solutionIdFromResultUrl("https://evil.example/api/ide/submit?solution_id=1")).toBeNull();
    expect(
      solutionIdFromResultUrl("https://www.codechef.com/api/ide/run/X?solution_id=1"),
    ).toBeNull();
    expect(
      solutionIdFromResultUrl("https://www.codechef.com/api/ide/submit?solution_id=abc"),
    ).toBeNull();
  });

  it("reads exact source code", () => {
    const code = parseSubmissionCode(cc("submission-code.json"));
    expect(code).toBe(EXPECTED);
    expect(code).toContain("\r\n\tint t; cin >> t;  \r\n");
    expect(() => parseSubmissionCode({ message: "login required" })).toThrow(/Unrecognized/);
  });

  it("reads the problem title", () => {
    expect(parseProblemTitle(cc("problem.json"))).toBe("Add Two Numbers");
    expect(parseProblemTitle({ status: "error", problem_name: "x" })).toBeNull();
    expect(parseProblemTitle({})).toBeNull();
  });

  it("maps language ids to names the language table understands", () => {
    expect(languageName(cc("languages.json"), "63")).toBe("C++17");
    expect(languageName(cc("languages.json"), "116")).toBe("PYTH 3");
    expect(languageName(cc("languages.json"), "10")).toBe("JAVA");
    expect(languageName(cc("languages.json"), "999")).toBe("WEIRD"); // unknown: raw name kept, uploader reports it
    expect(languageName(cc("languages.json"), "1")).toBeNull();
    expect(resolveLanguage("C++17").extension).toBe("cpp");
    expect(resolveLanguage("PYTH 3").extension).toBe("py");
  });

  it("builds practice and contest problem URLs", () => {
    expect(problemUrl("FLOW001", "PRACTICE")).toBe("https://www.codechef.com/problems/FLOW001");
    expect(problemUrl("ABC", "START100")).toBe("https://www.codechef.com/START100/problems/ABC");
  });
});

describe("CodeChef event", () => {
  const base = {
    submissionId: "1100223344",
    problemCode: "FLOW001",
    contestCode: "PRACTICE",
    language: "C++17",
    title: "Add Two Numbers",
    code: EXPECTED,
    submittedAt: 10,
    detectedAt: 20,
  };

  it("builds an exact event", async () => {
    expect(await buildEvent(base)).toEqual({
      platform: "codechef",
      problemKey: "FLOW001",
      problemSlug: "flow001-add-two-numbers",
      problemId: "FLOW001",
      problemTitle: "Add Two Numbers",
      problemUrl: "https://www.codechef.com/problems/FLOW001",
      submissionId: "1100223344",
      language: "C++17",
      languageNormalized: "cpp",
      sourceCode: EXPECTED,
      sourceSha256: await sha256Hex(EXPECTED),
      verdict: "ACCEPTED",
      submittedAt: 10,
      detectedAt: 20,
      contest: { id: "PRACTICE", kind: "practice" },
    });
  });

  it("records contest submissions and falls back to the code without a title", async () => {
    const e = await buildEvent({ ...base, contestCode: "START100", title: "" });
    expect(e.contest).toEqual({ id: "START100", kind: "contest" });
    expect(e.problemSlug).toBe("flow001");
    expect(e.problemUrl).toBe("https://www.codechef.com/START100/problems/FLOW001");
  });

  it("refuses unsafe codes and empty source", async () => {
    await expect(buildEvent({ ...base, problemCode: "../x" })).rejects.toThrow(/problem code/);
    await expect(buildEvent({ ...base, contestCode: "a/b" })).rejects.toThrow(/contest code/);
    await expect(buildEvent({ ...base, code: "" })).rejects.toThrow(/no source/);
  });
});
