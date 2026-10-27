import type { Platform, SubmissionEvent, Verdict } from "@cst/shared";
import type { VerdictObserved } from "../messages.js";

export interface ProblemMetadata {
  problemKey: string;
  problemSlug: string;
  problemTitle: string;
  problemUrl: string;
  problemId?: string;
  contest?: SubmissionEvent["contest"];
}

export type ObservedVerdict = Omit<VerdictObserved, "type">;

export interface AdapterContext {
  /** Report a verdict seen on the page (any verdict). */
  emitVerdict(v: ObservedVerdict): void;
  /** Report a fully assembled accepted submission with verified source code. */
  emitSubmission(e: SubmissionEvent): void;
  signal: AbortSignal;
}

/**
 * One per platform. The parsing layer (payload/DOM snapshot -> event) is
 * kept pure and fixture-tested; `start` is the thin I/O layer that observes
 * the page or network and calls the parsers.
 */
export interface CodingPlatformAdapter {
  readonly platform: Platform;
  canHandle(url: string): boolean;
  start(ctx: AdapterContext): void;
  normalizeVerdict(raw: unknown): Verdict;
}
