import { sha256Hex, type SubmissionEvent } from "@cst/shared";
import type { KeyValueStore } from "../src/storage.js";

export const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";

/** In-memory store that clones on read/write like chrome.storage does. */
export class MemoryStore implements KeyValueStore {
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

export async function makeEvent(
  overrides: Partial<SubmissionEvent> = {},
): Promise<SubmissionEvent> {
  const sourceCode =
    overrides.sourceCode ?? "class Solution:\r\n\tdef f(self):  \n\t\treturn 'é'\n";
  return {
    platform: "leetcode",
    problemKey: "two-sum",
    problemSlug: "two-sum",
    problemTitle: "Two Sum",
    problemUrl: "https://leetcode.com/problems/two-sum/",
    submissionId: "1001",
    language: "python3",
    verdict: "ACCEPTED",
    submittedAt: 1_700_000_000_000,
    detectedAt: 1_700_000_000_500,
    ...overrides,
    sourceCode,
    sourceSha256: overrides.sourceSha256 ?? (await sha256Hex(sourceCode)),
  };
}

export function contentSender(
  url = "https://leetcode.com/problems/two-sum/submissions/1001/",
): chrome.runtime.MessageSender {
  return { id: EXT_ID, url, frameId: 0, tab: { id: 1 } as chrome.tabs.Tab };
}

export function pageSender(path = "popup.html"): chrome.runtime.MessageSender {
  return { id: EXT_ID, url: `chrome-extension://${EXT_ID}/${path}` };
}
