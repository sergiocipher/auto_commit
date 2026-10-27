import { z } from "zod";
import { listenFromPage, type BridgeWindow } from "../../content/bridge.js";
import type { CodingPlatformAdapter } from "../types.js";
import { LEETCODE_CHECK_CHANNEL } from "./channel.js";
import {
  buildEvent,
  LEETCODE_ORIGIN,
  normalizeVerdict,
  parseCheck,
  parseDetails,
  parseTitle,
  QUESTION_TITLE_QUERY,
  RECENT_SUBMISSION_MS,
  submissionFromPageUrl,
  submissionIdFromCheckUrl,
  SUBMISSION_DETAILS_QUERY,
  titleSlugFromUrl,
  type CheckResult,
} from "./parse.js";

const CheckRelaySchema = z.strictObject({ url: z.string().max(2048), body: z.unknown() });

export interface LeetCodeEnv {
  win: BridgeWindow & { location: { origin: string; href: string } };
  /** Same-origin fetch (content scripts send the page's cookies). */
  fetch: (
    url: string,
    init: RequestInit,
  ) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  now: () => number;
  csrfToken: () => string | undefined;
  urlPollMs?: number;
  /** Diagnostics only; never receives source code. */
  log?: (message: string) => void;
}

export function createLeetCodeAdapter(env: LeetCodeEnv): CodingPlatformAdapter {
  async function graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const csrf = env.csrfToken();
    const res = await env.fetch(`${LEETCODE_ORIGIN}/graphql/`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(csrf ? { "x-csrftoken": csrf } : {}) },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`LeetCode GraphQL returned ${res.status}`);
    return res.json();
  }

  return {
    platform: "leetcode",
    canHandle(url) {
      try {
        return new URL(url).origin === LEETCODE_ORIGIN;
      } catch {
        return false;
      }
    },
    normalizeVerdict,
    start(ctx) {
      const inflight = new Set<string>();
      const done = new Set<string>();
      const checks = new Map<string, CheckResult>();

      async function captureAccepted(submissionId: string, recentOnly: boolean): Promise<void> {
        if (inflight.has(submissionId) || done.has(submissionId) || ctx.signal.aborted) return;
        inflight.add(submissionId);
        try {
          const details = parseDetails(
            await graphql(SUBMISSION_DETAILS_QUERY, { submissionId: Number(submissionId) }),
            submissionId,
          );
          const accepted = details.statusCode === 10;
          if (recentOnly && env.now() - details.submittedAt > RECENT_SUBMISSION_MS) return;
          ctx.emitVerdict({
            platform: "leetcode",
            submissionId,
            verdict: accepted ? "ACCEPTED" : "REJECTED",
            problemKey: details.titleSlug,
            at: env.now(),
          });
          if (!accepted) return;
          const title = await graphql(QUESTION_TITLE_QUERY, { titleSlug: details.titleSlug }).then(
            parseTitle,
            () => null,
          );
          const event = await buildEvent(details, {
            pageTitleSlug: titleSlugFromUrl(env.win.location.href),
            check: checks.get(submissionId) ?? null,
            title,
            detectedAt: env.now(),
          });
          done.add(submissionId);
          ctx.emitSubmission(event);
        } catch (err) {
          env.log?.(
            `LeetCode submission ${submissionId} not captured: ${err instanceof Error ? err.message : "error"}`,
          );
        } finally {
          inflight.delete(submissionId);
        }
      }

      listenFromPage(
        env.win,
        LEETCODE_CHECK_CHANNEL,
        CheckRelaySchema,
        ({ url, body }) => {
          const submissionId = submissionIdFromCheckUrl(url);
          const result = submissionId ? parseCheck(body) : null;
          if (!submissionId || !result) return;
          if (result.submissionId && result.submissionId !== submissionId) return;
          const problemKey = titleSlugFromUrl(env.win.location.href);
          ctx.emitVerdict({
            platform: "leetcode",
            submissionId,
            verdict: result.verdict,
            rawVerdict: result.rawVerdict,
            ...(problemKey ? { problemKey } : {}),
            at: env.now(),
          });
          if (result.final) checks.set(submissionId, result);
          if (result.verdict === "ACCEPTED") void captureAccepted(submissionId, false);
        },
        ctx.signal,
      );

      // Fallback for SPA navigation to /problems/<slug>/submissions/<id>/.
      let lastHref = "";
      const tick = () => {
        const href = env.win.location.href;
        if (href === lastHref) return;
        lastHref = href;
        const page = submissionFromPageUrl(href);
        if (page) void captureAccepted(page.submissionId, true);
      };
      tick();
      const timer = setInterval(tick, env.urlPollMs ?? 1000);
      ctx.signal.addEventListener("abort", () => clearInterval(timer));
    },
  };
}
