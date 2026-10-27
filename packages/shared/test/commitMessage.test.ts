import { describe, expect, it } from "vitest";
import { buildCommitMessage } from "../src/index.js";

describe("buildCommitMessage", () => {
  it("formats LeetCode without the key", () => {
    expect(
      buildCommitMessage({
        platform: "leetcode",
        problemTitle: "Two Sum",
        problemKey: "two-sum",
        languageDisplay: "C++",
      }),
    ).toBe("feat(solutions): add LeetCode - Two Sum (C++)");
  });

  it("prefixes the key for Codeforces and CodeChef", () => {
    expect(
      buildCommitMessage({
        platform: "codeforces",
        problemTitle: "Watermelon",
        problemKey: "4A",
        languageDisplay: "C++",
      }),
    ).toBe("feat(solutions): add Codeforces - 4A Watermelon (C++)");
    expect(
      buildCommitMessage({
        platform: "codechef",
        problemTitle: "Add Two Numbers",
        problemKey: "FLOW001",
        languageDisplay: "Python",
      }),
    ).toBe("feat(solutions): add CodeChef - FLOW001 Add Two Numbers (Python)");
  });

  it("falls back to Unknown Problem with the key", () => {
    expect(
      buildCommitMessage({
        platform: "leetcode",
        problemTitle: "  ",
        problemKey: "two-sum",
        languageDisplay: "Java",
      }),
    ).toBe("feat(solutions): add LeetCode - two-sum Unknown Problem (Java)");
  });

  it("keeps the message on one line and strips control characters", () => {
    const msg = buildCommitMessage({
      platform: "leetcode",
      problemTitle: "Two\nSum\r\n\u0007‮",
      problemKey: "two-sum",
      languageDisplay: "C++\n",
    });
    expect(msg).toBe("feat(solutions): add LeetCode - Two Sum (C++)");
  });

  it("truncates long titles to stay within 100 characters", () => {
    const msg = buildCommitMessage({
      platform: "codeforces",
      problemTitle: "A".repeat(300),
      problemKey: "1234E",
      languageDisplay: "C++",
    });
    expect(msg.length).toBeLessThanOrEqual(100);
    expect(msg).toMatch(/^feat\(solutions\): add Codeforces - 1234E A+\.\.\. \(C\+\+\)$/);
  });

  it("does not split surrogate pairs when truncating", () => {
    const msg = buildCommitMessage({
      platform: "leetcode",
      problemTitle: "😀".repeat(200),
      problemKey: "x",
      languageDisplay: "C",
    });
    expect(msg).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});
