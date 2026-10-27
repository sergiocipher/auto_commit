import { buildProblemSlug, sha256Hex, type SubmissionEvent } from "@cst/shared";
import { KeyValueJobStore, type KeyValue } from "../src/index.js";

import { fakeToken } from "./fakeToken.js";

export { fakeToken };
/** Same value as FAKE_TOKEN in fakeGitHub.ts, the token the fake accepts by default. */
export const TOKEN = fakeToken("gho", "fake");
export const T0 = Date.parse("2024-03-10T10:00:00Z");
export const HOUR = 3_600_000;

export class MemoryKV implements KeyValue {
  readonly data = new Map<string, unknown>();
  async get(key: string) {
    const v = this.data.get(key);
    return v === undefined ? undefined : structuredClone(v);
  }
  async set(key: string, value: unknown) {
    this.data.set(key, structuredClone(value));
  }
  async remove(key: string) {
    this.data.delete(key);
  }
}

export const newStore = () => new KeyValueJobStore(new MemoryKV());

let ids = 0;
export const newId = () => `job-${++ids}`;

export async function makeEvent(
  overrides: Partial<SubmissionEvent> = {},
): Promise<SubmissionEvent> {
  const sourceCode =
    overrides.sourceCode ??
    "class Solution {\r\npublic:\n\tint f() { return 1; }  \n};\n// ünïcödé ✓\n";
  const platform = overrides.platform ?? "leetcode";
  const problemKey = overrides.problemKey ?? "two-sum";
  const problemTitle = overrides.problemTitle ?? "Two Sum";
  return {
    platform,
    problemKey,
    problemSlug: overrides.problemSlug ?? buildProblemSlug(platform, problemKey, problemTitle),
    problemTitle,
    problemUrl: overrides.problemUrl ?? "https://leetcode.com/problems/two-sum/",
    submissionId: "1001",
    language: "cpp",
    verdict: "ACCEPTED",
    submittedAt: T0,
    detectedAt: T0 + 1000,
    ...overrides,
    sourceCode,
    sourceSha256: overrides.sourceSha256 ?? (await sha256Hex(sourceCode)),
  };
}
