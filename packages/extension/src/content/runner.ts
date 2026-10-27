import type { SubmissionEvent } from "@cst/shared";
import type { ContentMessage } from "../messages.js";
import { submissionKey } from "../platforms.js";
import type { CodingPlatformAdapter, ObservedVerdict } from "../adapters/types.js";

export type SendToBackground = (message: ContentMessage) => Promise<unknown>;

/**
 * Runs an adapter in a content script. Platforms re-render and re-poll, so
 * the same verdict or submission is often reported several times; repeats
 * are dropped here before anything is messaged to the service worker.
 */
export function runAdapter(
  adapter: CodingPlatformAdapter,
  url: string,
  send: SendToBackground,
  signal: AbortSignal,
  now: () => number = Date.now,
): boolean {
  if (!adapter.canHandle(url)) return false;
  const sentVerdicts = new Set<string>();
  const sentSubmissions = new Set<string>();

  const safeSend = (message: ContentMessage) => {
    // The service worker may be restarting; it re-validates everything anyway.
    send(message).catch(() => undefined);
  };

  adapter.start({
    signal,
    emitVerdict(v: ObservedVerdict) {
      const key = `${submissionKey(v.platform, v.submissionId)}:${v.verdict}`;
      if (signal.aborted || sentVerdicts.has(key)) return;
      sentVerdicts.add(key);
      safeSend({ type: "verdict/observed", ...v, at: v.at || now() });
    },
    emitSubmission(event: SubmissionEvent) {
      const key = submissionKey(event.platform, event.submissionId);
      if (signal.aborted || event.verdict !== "ACCEPTED" || sentSubmissions.has(key)) return;
      sentSubmissions.add(key);
      safeSend({ type: "submission/detected", event });
    },
  });
  return true;
}
