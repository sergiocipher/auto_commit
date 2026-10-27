import type { CodingPlatformAdapter } from "../types.js";
import {
  buildEvent,
  CODEFORCES_ORIGIN,
  csrfToken,
  currentHandle,
  extractSourceFromSubmissionHtml,
  normalizeVerdict,
  parseStatusRows,
  parseSubmitSource,
  type StatusRow,
} from "./parse.js";

export interface CodeforcesEnv {
  doc: Document;
  /** Same-origin fetch with the user's session. */
  fetch: (
    url: string,
    init?: RequestInit,
  ) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  now: () => number;
  /** document.referrer, used to recognise "just submitted" redirects. */
  referrer: string;
  observe: (onChange: () => void, signal: AbortSignal) => void;
  log?: (message: string) => void;
}

/** True when we arrived on this page straight from a Codeforces submit form. */
function cameFromSubmit(referrer: string): boolean {
  try {
    const u = new URL(referrer);
    return u.origin === CODEFORCES_ORIGIN && /\/submit(?:\/|$)/.test(u.pathname);
  } catch {
    return false;
  }
}

export function createCodeforcesAdapter(env: CodeforcesEnv): CodingPlatformAdapter {
  async function fetchSource(row: StatusRow): Promise<string> {
    const csrf = csrfToken(env.doc);
    if (csrf) {
      try {
        const res = await env.fetch(`${CODEFORCES_ORIGIN}/data/submitSource`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Csrf-Token": csrf,
          },
          body: `submissionId=${encodeURIComponent(row.submissionId)}&csrf_token=${encodeURIComponent(csrf)}`,
        });
        if (res.ok) return parseSubmitSource(JSON.parse(await res.text()));
        env.log?.(`submitSource returned ${res.status}; trying the submission page`);
      } catch (err) {
        env.log?.(
          `submitSource failed (${err instanceof Error ? err.message : "error"}); trying the submission page`,
        );
      }
    }
    const res = await env.fetch(row.submissionUrl, { credentials: "include" });
    if (!res.ok) throw new Error(`submission page returned ${res.status}`);
    return extractSourceFromSubmissionHtml(await res.text());
  }

  return {
    platform: "codeforces",
    canHandle(url) {
      try {
        return new URL(url).origin === CODEFORCES_ORIGIN;
      } catch {
        return false;
      }
    },
    normalizeVerdict,
    start(ctx) {
      const handle = currentHandle(env.doc);
      if (!handle) {
        env.log?.("not logged in to Codeforces; nothing to observe");
        return;
      }
      const firstSeenPending = new Map<string, number>();
      const captured = new Set<string>();
      let freshCandidate = cameFromSubmit(env.referrer);
      let firstScan = true;

      async function capture(row: StatusRow): Promise<void> {
        if (captured.has(row.submissionId)) return;
        captured.add(row.submissionId);
        try {
          const source = await fetchSource(row);
          const now = env.now();
          const event = await buildEvent(row, source, {
            submittedAt: firstSeenPending.get(row.submissionId) ?? now,
            detectedAt: now,
          });
          if (!ctx.signal.aborted) ctx.emitSubmission(event);
        } catch (err) {
          captured.delete(row.submissionId); // allow a later retry (e.g. after re-render)
          env.log?.(
            `Codeforces submission ${row.submissionId} not captured: ${err instanceof Error ? err.message : "error"}`,
          );
        }
      }

      function scan(): void {
        if (ctx.signal.aborted) return;
        const own = parseStatusRows(env.doc).filter(
          (r) => r.authorHandle !== null && r.authorHandle.toLowerCase() === handle!.toLowerCase(),
        );
        own.forEach((row, i) => {
          ctx.emitVerdict({
            platform: "codeforces",
            submissionId: row.submissionId,
            verdict: row.verdict,
            rawVerdict: row.rawVerdict.slice(0, 100),
            problemKey: `${row.contestId}${row.problemIndex}`,
            ...(row.problemName ? { problemTitle: row.problemName } : {}),
            at: env.now(),
          });
          if (row.verdict === "PENDING") {
            if (!firstSeenPending.has(row.submissionId))
              firstSeenPending.set(row.submissionId, env.now());
            return;
          }
          if (row.verdict !== "ACCEPTED") return;
          // Only submissions judged while we watched, or the newest one right after a submit.
          // Accepted rows already on the page from earlier are history and never uploaded.
          const sawJudging = firstSeenPending.has(row.submissionId);
          const justSubmitted = freshCandidate && firstScan && i === 0;
          if (sawJudging || justSubmitted) void capture(row);
        });
        if (firstScan && own.length > 0) freshCandidate = false;
        firstScan = false;
      }

      scan();
      env.observe(scan, ctx.signal);
    },
  };
}
