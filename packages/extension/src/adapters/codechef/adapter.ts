import { z } from "zod";
import { listenFromPage, type BridgeWindow } from "../../content/bridge.js";
import type { CodingPlatformAdapter } from "../types.js";
import { CODECHEF_RESULT_CHANNEL, CODECHEF_SUBMIT_CHANNEL } from "./channel.js";
import {
  buildEvent,
  CODECHEF_ORIGIN,
  isValidCode,
  languageName,
  normalizeVerdict,
  parseProblemTitle,
  parseResult,
  parseSubmissionCode,
  parseSubmitResponse,
  solutionIdFromResultUrl,
} from "./parse.js";

const SubmitRelaySchema = z.strictObject({
  problemCode: z.string().max(40),
  contestCode: z.string().max(40),
  languageId: z.string().max(20),
  response: z.unknown(),
  csrfToken: z.string().max(500).optional(),
  ideKey: z.string().max(500).optional(),
});
const ResultRelaySchema = z.strictObject({ url: z.string().max(2048), body: z.unknown() });

export interface CodeChefEnv {
  win: BridgeWindow & { location: { origin: string; href: string } };
  fetch: (
    url: string,
    init: RequestInit,
  ) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  now: () => number;
  log?: (message: string) => void;
}

interface SubmitInfo {
  problemCode: string;
  contestCode: string;
  languageId: string;
  submittedAt: number;
  csrfToken?: string;
  ideKey?: string;
}

export function createCodeChefAdapter(env: CodeChefEnv): CodingPlatformAdapter {
  async function getJson(path: string, info: SubmitInfo): Promise<unknown> {
    const res = await env.fetch(`${CODECHEF_ORIGIN}${path}`, {
      credentials: "include",
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        ...(info.csrfToken ? { "x-csrf-token": info.csrfToken } : {}),
        ...(info.ideKey && path.startsWith("/api/ide") ? { "x-cc-ide-key": info.ideKey } : {}),
      },
    });
    if (!res.ok) throw new Error(`${path.split("?")[0]} returned ${res.status}`);
    return res.json();
  }

  return {
    platform: "codechef",
    canHandle(url) {
      try {
        const origin = new URL(url).origin;
        return origin === CODECHEF_ORIGIN || origin === "https://codechef.com";
      } catch {
        return false;
      }
    },
    normalizeVerdict,
    start(ctx) {
      // Only submissions made from this page are eligible for upload.
      const submits = new Map<string, SubmitInfo>();
      const inflight = new Set<string>();
      const done = new Set<string>();

      async function capture(submissionId: string, info: SubmitInfo): Promise<void> {
        if (inflight.has(submissionId) || done.has(submissionId) || ctx.signal.aborted) return;
        inflight.add(submissionId);
        try {
          const contest = info.contestCode || "PRACTICE";
          const code = parseSubmissionCode(
            await getJson(`/api/submission-code/${submissionId}`, info),
          );
          const [title, language] = await Promise.all([
            getJson(`/api/contests/${contest}/problems/${info.problemCode}`, info).then(
              parseProblemTitle,
              () => null,
            ),
            getJson(`/api/ide/${contest}/languages/${info.problemCode}`, info).then(
              (raw) => languageName(raw, info.languageId),
              () => null,
            ),
          ]);
          const event = await buildEvent({
            submissionId,
            problemCode: info.problemCode,
            contestCode: contest,
            // Unknown names fall back to the numeric id; the uploader then reports
            // an unsupported language (fixable with a settings override).
            language: language ?? `CodeChef language ${info.languageId}`,
            title: title ?? "",
            code,
            submittedAt: info.submittedAt,
            detectedAt: env.now(),
          });
          done.add(submissionId);
          if (!ctx.signal.aborted) ctx.emitSubmission(event);
        } catch (err) {
          env.log?.(
            `CodeChef submission ${submissionId} not captured: ${err instanceof Error ? err.message : "error"}`,
          );
        } finally {
          inflight.delete(submissionId);
        }
      }

      listenFromPage(
        env.win,
        CODECHEF_SUBMIT_CHANNEL,
        SubmitRelaySchema,
        (p) => {
          const upid = parseSubmitResponse(p.response);
          if (
            !upid ||
            !isValidCode(p.problemCode) ||
            (p.contestCode && !isValidCode(p.contestCode))
          )
            return;
          if (!/^\d+$/.test(p.languageId)) return;
          submits.set(upid, {
            problemCode: p.problemCode.toUpperCase(),
            contestCode: p.contestCode.toUpperCase(),
            languageId: p.languageId,
            submittedAt: env.now(),
            ...(p.csrfToken ? { csrfToken: p.csrfToken } : {}),
            ...(p.ideKey ? { ideKey: p.ideKey } : {}),
          });
          ctx.emitVerdict({
            platform: "codechef",
            submissionId: upid,
            verdict: "PENDING",
            rawVerdict: "Submission Queued",
            problemKey: p.problemCode.toUpperCase(),
            at: env.now(),
          });
        },
        ctx.signal,
      );

      listenFromPage(
        env.win,
        CODECHEF_RESULT_CHANNEL,
        ResultRelaySchema,
        ({ url, body }) => {
          const submissionId = solutionIdFromResultUrl(url);
          const result = submissionId ? parseResult(body) : null;
          if (!submissionId || !result) return;
          if (result.upid && result.upid !== submissionId) return;
          const info = submits.get(submissionId);
          ctx.emitVerdict({
            platform: "codechef",
            submissionId,
            verdict: result.verdict,
            rawVerdict: result.rawVerdict.slice(0, 100),
            ...(info ? { problemKey: info.problemCode } : {}),
            at: env.now(),
          });
          if (result.verdict === "ACCEPTED" && info) void capture(submissionId, info);
        },
        ctx.signal,
      );
    },
  };
}
