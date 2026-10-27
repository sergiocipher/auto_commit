import { describe, expect, it } from "vitest";
import { classifyResponse, networkError, redact } from "../src/index.js";
import { fakeToken } from "./fakeToken.js";

const GHP = fakeToken("ghp", "abcdefghijklmnopqrstuvwxyz012345");

const NOW = 1_700_000_000_000;
const res = (status: number, headers: Record<string, string> = {}) => ({
  status,
  headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
});

describe("classifyResponse", () => {
  it("401 needs reconnect", () => {
    expect(classifyResponse(res(401), '{"message":"Bad credentials"}', NOW, "x").kind).toBe(
      "needs_auth",
    );
  });
  it("403 without rate limiting is permanent (no write access)", () => {
    const e = classifyResponse(
      res(403),
      '{"message":"Resource not accessible by integration"}',
      NOW,
      "updating the branch",
    );
    expect(e.kind).toBe("permanent");
    expect(e.message).toMatch(
      /^No write access while updating the branch.*: Resource not accessible by integration$/,
    );
  });
  it("403 primary rate limit waits until x-ratelimit-reset", () => {
    const e = classifyResponse(
      res(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW / 1000 + 120) }),
      "{}",
      NOW,
      "x",
    );
    expect(e.kind).toBe("retryable");
    expect(e.retryAfterMs).toBe(120_000);
  });
  it("403 secondary rate limit is retryable", () => {
    const e = classifyResponse(
      res(403),
      '{"message":"You have exceeded a secondary rate limit"}',
      NOW,
      "x",
    );
    expect(e.kind).toBe("retryable");
    expect(e.retryAfterMs).toBe(60_000);
  });
  it("429 honors Retry-After seconds and HTTP dates", () => {
    expect(classifyResponse(res(429, { "retry-after": "30" }), "", NOW, "x").retryAfterMs).toBe(
      30_000,
    );
    const date = new Date(NOW + 90_000).toUTCString();
    expect(classifyResponse(res(429, { "retry-after": date }), "", NOW, "x").retryAfterMs).toBe(
      90_000,
    );
  });
  it("404 is permanent; 5xx is retryable; 422 is permanent", () => {
    expect(classifyResponse(res(404), "", NOW, "x").kind).toBe("permanent");
    expect(classifyResponse(res(502), "<html>", NOW, "x").kind).toBe("retryable");
    expect(classifyResponse(res(422), '{"message":"Invalid"}', NOW, "x").kind).toBe("permanent");
  });
  it("redacts tokens echoed in error bodies", () => {
    const e = classifyResponse(res(500), JSON.stringify({ message: `oops ${GHP}` }), NOW, "x");
    expect(e.message).not.toContain("ghp_abcdef");
  });
  it("network failures are retryable", () => {
    expect(networkError(new TypeError("Failed to fetch"), "x").kind).toBe("retryable");
  });
});

describe("redact", () => {
  it.each([
    GHP,
    fakeToken("gho", "abcdefghijklmnopqrstuvwxyz012345"),
    fakeToken("github_pat", "11ABCDEFG0123456789_abcdefghijklmnop"),
    "Authorization: Bearer abc.def-ghi_jkl123",
    "token abcdef1234567890",
    "https://x/?access_token=supersecret&y=1",
    "device_code=abcdef0123",
  ])("hides %s", (text) => {
    const out = redact(text);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toMatch(/abcdef|supersecret|abc\.def/);
  });
  it("hides explicitly provided secrets", () => {
    expect(redact("value=my-local-secret!", ["my-local-secret"])).toBe("value=[REDACTED]!");
  });
  it("leaves ordinary text alone", () => {
    expect(redact("Not found while reading the branch head")).toBe(
      "Not found while reading the branch head",
    );
  });
});
