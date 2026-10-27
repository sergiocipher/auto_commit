import { describe, expect, it } from "vitest";
import { createSerialLock } from "../src/lock.js";
import { platformForUrl, submissionKey } from "../src/platforms.js";

describe("platformForUrl", () => {
  it.each([
    ["https://leetcode.com/problems/two-sum/", "leetcode"],
    ["https://codeforces.com/contest/4/my", "codeforces"],
    ["https://www.codechef.com/problems/FLOW001", "codechef"],
    ["https://codechef.com/", "codechef"],
    ["http://leetcode.com/", null],
    ["https://leetcode.com.evil.example/", null],
    ["https://evil.example/?u=https://leetcode.com/", null],
    ["https://m1.codeforces.com/", null],
    ["not a url", null],
    [undefined, null],
  ])("%s -> %s", (url, expected) => {
    expect(platformForUrl(url)).toBe(expected);
  });

  it("builds idempotency keys", () => {
    expect(submissionKey("codeforces", "123")).toBe("codeforces:123");
  });
});

describe("createSerialLock", () => {
  it("runs callbacks one at a time in call order, even after failures", async () => {
    const lock = createSerialLock();
    const order: string[] = [];
    const slow = lock(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push("a");
    });
    const failing = lock(async () => {
      order.push("b");
      throw new Error("x");
    });
    const after = lock(async () => {
      order.push("c");
    });
    await Promise.allSettled([slow, failing, after]);
    expect(order).toEqual(["a", "b", "c"]);
    await expect(failing).rejects.toThrow("x");
  });
});
