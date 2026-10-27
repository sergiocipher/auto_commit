import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SettingsSchema, SubmissionEventSchema } from "../src/index.js";

const event = {
  platform: "leetcode",
  problemKey: "two-sum",
  problemSlug: "two-sum",
  problemTitle: "Two Sum",
  problemUrl: "https://leetcode.com/problems/two-sum/",
  submissionId: "1234",
  language: "python3",
  sourceCode: "class Solution:\r\n\tpass  \n",
  sourceSha256: "0".repeat(64),
  verdict: "ACCEPTED",
  submittedAt: 1,
  detectedAt: 2,
};

describe("SubmissionEventSchema", () => {
  it("accepts a valid event and preserves source code exactly", () => {
    const parsed = SubmissionEventSchema.parse(event);
    expect(parsed.sourceCode).toBe(event.sourceCode);
  });
  it("rejects unknown fields", () => {
    expect(SubmissionEventSchema.safeParse({ ...event, token: "x" }).success).toBe(false);
  });
  it("rejects empty source code and bad hashes", () => {
    expect(SubmissionEventSchema.safeParse({ ...event, sourceCode: "" }).success).toBe(false);
    expect(SubmissionEventSchema.safeParse({ ...event, sourceSha256: "abc" }).success).toBe(false);
  });
});

describe("SettingsSchema", () => {
  it("accepts defaults", () => {
    expect(SettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });
  it("rejects unknown timezones and traversal in repo names", () => {
    expect(
      SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, timezone: "Mars/Olympus" }).success,
    ).toBe(false);
    expect(
      SettingsSchema.safeParse({
        ...DEFAULT_SETTINGS,
        repo: { owner: "..", name: "x", branch: "main" },
      }).success,
    ).toBe(false);
    expect(
      SettingsSchema.safeParse({
        ...DEFAULT_SETTINGS,
        repo: { owner: "a", name: "b", branch: "../main" },
      }).success,
    ).toBe(false);
  });
  it("rejects invalid custom hour windows", () => {
    expect(
      SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, period: { kind: "custom_hours", hours: 0 } })
        .success,
    ).toBe(false);
  });
});
