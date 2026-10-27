import { describe, expect, it } from "vitest";
import {
  assertSafeRepoPath,
  buildMetadataPath,
  buildProblemSlug,
  buildSolutionPath,
  InvalidPathError,
  MAX_SLUG_LENGTH,
  sanitizeSlug,
} from "../src/index.js";

describe("sanitizeSlug", () => {
  it.each([
    ["Two Sum", "two-sum"],
    ["  --Hello__World!!  ", "hello-world"],
    ["Crème Brûlée", "creme-brulee"],
    ["../../etc/passwd", "etc-passwd"],
    ["..\\..\\windows\\system32", "windows-system32"],
    ["/absolute/path", "absolute-path"],
    [".hidden", "hidden"],
    ["．．／ｅｔｃ", "etc"], // fullwidth "../etc"
    ["a‮b", "a-b"], // right-to-left override
    ["a\0b", "a-b"],
    ["", ""],
    ["日本語", ""],
    ["🔥🔥", ""],
  ])("%j -> %j", (input, expected) => {
    expect(sanitizeSlug(input)).toBe(expected);
  });

  it("caps length without leaving a trailing hyphen", () => {
    const slug = sanitizeSlug(`${"a".repeat(MAX_SLUG_LENGTH - 1)} bcdef`);
    expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("buildProblemSlug", () => {
  it("prefixes Codeforces titles with the problem key", () => {
    expect(buildProblemSlug("codeforces", "4A", "Watermelon")).toBe("4a-watermelon");
  });
  it("prefixes CodeChef titles with the problem code", () => {
    expect(buildProblemSlug("codechef", "FLOW001", "Add Two Numbers")).toBe(
      "flow001-add-two-numbers",
    );
  });
  it("uses the LeetCode titleSlug as-is", () => {
    expect(buildProblemSlug("leetcode", "two-sum", "Two Sum")).toBe("two-sum");
  });
  it("falls back to the key when the title is empty or unusable", () => {
    expect(buildProblemSlug("codechef", "FLOW001", "")).toBe("flow001");
    expect(buildProblemSlug("codeforces", "1A", "日本語")).toBe("1a");
  });
  it("rejects keys with nothing usable", () => {
    expect(() => buildProblemSlug("leetcode", "日本語", "x")).toThrow(InvalidPathError);
  });
  it("keeps same titles on different platforms in different folders", () => {
    const a = buildSolutionPath({ platform: "leetcode", problemSlug: "two-sum", extension: "py" });
    const b = buildSolutionPath({ platform: "codechef", problemSlug: "two-sum", extension: "py" });
    expect(a).not.toBe(b);
  });
});

describe("buildSolutionPath", () => {
  it("builds the default path under data/", () => {
    expect(
      buildSolutionPath({ platform: "codeforces", problemSlug: "4a-watermelon", extension: "cpp" }),
    ).toBe("data/codeforces/4a-watermelon/solution.cpp");
    expect(buildMetadataPath("codeforces", "4a-watermelon")).toBe(
      "data/codeforces/4a-watermelon/metadata.json",
    );
  });

  it("builds the collision path with a submission id", () => {
    expect(
      buildSolutionPath({
        platform: "leetcode",
        problemSlug: "two-sum",
        extension: "py",
        submissionId: "123456",
      }),
    ).toBe("data/leetcode/two-sum/solution-123456.py");
  });

  it.each(["../x", "a/b", ".x", "A-B", "", "a--b", "a b", "-a"])(
    "rejects slug %j",
    (problemSlug) => {
      expect(() =>
        buildSolutionPath({ platform: "leetcode", problemSlug, extension: "py" }),
      ).toThrow(InvalidPathError);
    },
  );

  it.each(["", "c/../x", ".py", "PY", "a.b", "toolongextension"])(
    "rejects extension %j",
    (extension) => {
      expect(() =>
        buildSolutionPath({ platform: "leetcode", problemSlug: "x", extension }),
      ).toThrow(InvalidPathError);
    },
  );

  it("strips traversal from submission ids", () => {
    expect(
      buildSolutionPath({
        platform: "leetcode",
        problemSlug: "x",
        extension: "py",
        submissionId: "../../12",
      }),
    ).toBe("data/leetcode/x/solution-12.py");
    expect(() =>
      buildSolutionPath({
        platform: "leetcode",
        problemSlug: "x",
        extension: "py",
        submissionId: "../",
      }),
    ).toThrow(InvalidPathError);
  });

  it("rejects unknown platforms", () => {
    expect(() =>
      buildSolutionPath({ platform: "../evil" as never, problemSlug: "x", extension: "py" }),
    ).toThrow(InvalidPathError);
  });
});

describe("assertSafeRepoPath", () => {
  it.each(["data/a/b.txt", "data/x"])("accepts %j", (p) =>
    expect(() => assertSafeRepoPath(p)).not.toThrow(),
  );
  it.each([
    "/data/a",
    "data/../a",
    "data//a",
    "data/./a",
    "src/a",
    "data/a\\b",
    "data/.git/config",
    "data",
  ])("rejects %j", (p) => expect(() => assertSafeRepoPath(p)).toThrow(InvalidPathError));
});
