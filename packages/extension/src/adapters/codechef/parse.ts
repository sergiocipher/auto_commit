import { z } from "zod";
import {
  buildProblemSlug,
  resolveLanguage,
  sha256Hex,
  type SubmissionEvent,
  type Verdict,
} from "@cst/shared";
import { SUBMIT_PATH } from "./channel.js";

export const CODECHEF_ORIGIN = "https://www.codechef.com";
const CODE_RE = /^[A-Za-z0-9_]{1,40}$/;

// result_code values from CodeChef's IDE client (see docs/platforms/codechef.md).
const REJECTED_CODES = new Set([
  "partial_accepted",
  "wrong",
  "time",
  "runtime",
  "compile",
  "error",
  "server_errors",
  "judge_error",
  "problem_error",
  "score",
  "limit",
]);
const LABELS: Record<string, string> = {
  wait: "Submission Queued",
  accepted: "Correct Answer",
  partial_accepted: "Partially Correct Answer",
  wrong: "Wrong Answer",
  time: "Time Limit Exceeded",
  runtime: "Runtime Error",
  compile: "Compilation Error",
};

const ResultSchema = z.looseObject({
  result_code: z.string().optional(),
  upid: z.union([z.string(), z.number()]).optional(),
});

/** Only result_code "accepted" is ACCEPTED; known failures are REJECTED; anything else is still PENDING. */
export function normalizeVerdict(raw: unknown): Verdict {
  const parsed = ResultSchema.safeParse(raw);
  const code = parsed.success ? parsed.data.result_code : undefined;
  if (code === "accepted") return "ACCEPTED";
  if (code && REJECTED_CODES.has(code)) return "REJECTED";
  return "PENDING";
}

export interface ResultInfo {
  verdict: Verdict;
  rawVerdict: string;
  upid?: string;
}

export function parseResult(raw: unknown): ResultInfo | null {
  const parsed = ResultSchema.safeParse(raw);
  if (!parsed.success) return null;
  const code = parsed.data.result_code ?? "wait";
  return {
    verdict: normalizeVerdict(raw),
    rawVerdict: LABELS[code] ?? code,
    ...(parsed.data.upid !== undefined ? { upid: String(parsed.data.upid) } : {}),
  };
}

const SubmitResponseSchema = z.looseObject({
  status: z.string().optional(),
  upid: z.union([z.string(), z.number()]).optional(),
});

/** Submission id from the POST /api/ide/submit response, or null if refused. */
export function parseSubmitResponse(raw: unknown): string | null {
  const parsed = SubmitResponseSchema.safeParse(raw);
  if (!parsed.success || parsed.data.status === "error" || parsed.data.upid === undefined)
    return null;
  const id = String(parsed.data.upid);
  return /^\d+$/.test(id) ? id : null;
}

export function isValidCode(code: string): boolean {
  return CODE_RE.test(code);
}

/** solution_id from a GET /api/ide/submit?solution_id=… URL on a CodeChef origin. */
export function solutionIdFromResultUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.origin !== CODECHEF_ORIGIN && u.origin !== "https://codechef.com") return null;
    if (u.pathname.replace(/\/$/, "") !== SUBMIT_PATH) return null;
    const id = u.searchParams.get("solution_id") ?? "";
    return /^\d+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export class CodeChefParseError extends Error {
  override name = "CodeChefParseError";
}

const SubmissionCodeSchema = z.looseObject({ data: z.looseObject({ code: z.string() }) });

export function parseSubmissionCode(raw: unknown): string {
  const parsed = SubmissionCodeSchema.safeParse(raw);
  if (!parsed.success)
    throw new CodeChefParseError(
      "Unrecognized submission-code response (logged out or not your submission?).",
    );
  return parsed.data.data.code;
}

const ProblemSchema = z.looseObject({ status: z.string().optional(), problem_name: z.string() });

export function parseProblemTitle(raw: unknown): string | null {
  const parsed = ProblemSchema.safeParse(raw);
  if (!parsed.success || (parsed.data.status !== undefined && parsed.data.status !== "success"))
    return null;
  return parsed.data.problem_name;
}

const LanguagesSchema = z.looseObject({
  languages: z.array(
    z.looseObject({
      id: z.union([z.string(), z.number()]),
      short_name: z.string().optional(),
      full_name: z.string().optional(),
    }),
  ),
});

/**
 * Raw language name for a submitted language id: short_name when the shared
 * table recognises it, else full_name, else whichever exists. Null if unknown.
 */
export function languageName(raw: unknown, languageId: string): string | null {
  const parsed = LanguagesSchema.safeParse(raw);
  if (!parsed.success) return null;
  const lang = parsed.data.languages.find((l) => String(l.id) === languageId);
  if (!lang) return null;
  const candidates = [lang.short_name, lang.full_name].filter(
    (n): n is string => !!n && n.trim().length > 0,
  );
  for (const name of candidates) {
    try {
      resolveLanguage(name);
      return name;
    } catch {
      // try the next name
    }
  }
  return candidates[0] ?? null;
}

export function problemUrl(problemCode: string, contestCode: string): string {
  return contestCode === "PRACTICE" || contestCode === ""
    ? `${CODECHEF_ORIGIN}/problems/${problemCode}`
    : `${CODECHEF_ORIGIN}/${contestCode}/problems/${problemCode}`;
}

export interface CapturedSubmission {
  submissionId: string;
  problemCode: string;
  contestCode: string;
  language: string;
  title: string;
  code: string;
  submittedAt: number;
  detectedAt: number;
}

export async function buildEvent(s: CapturedSubmission): Promise<SubmissionEvent> {
  if (!isValidCode(s.problemCode)) throw new CodeChefParseError("Invalid problem code.");
  if (s.contestCode && !isValidCode(s.contestCode))
    throw new CodeChefParseError("Invalid contest code.");
  if (s.code.length === 0) throw new CodeChefParseError("Submission has no source code.");
  const problemKey = s.problemCode.toUpperCase();
  const contestCode = s.contestCode.toUpperCase() || "PRACTICE";
  let languageNormalized: string | undefined;
  try {
    languageNormalized = resolveLanguage(s.language).normalized;
  } catch {
    // reported by the uploader, or mapped by a user override
  }
  return {
    platform: "codechef",
    problemKey,
    problemSlug: buildProblemSlug("codechef", problemKey, s.title),
    problemId: problemKey,
    problemTitle: s.title,
    problemUrl: problemUrl(problemKey, contestCode),
    submissionId: s.submissionId,
    language: s.language,
    ...(languageNormalized ? { languageNormalized } : {}),
    sourceCode: s.code,
    sourceSha256: await sha256Hex(s.code),
    verdict: "ACCEPTED",
    submittedAt: s.submittedAt,
    detectedAt: s.detectedAt,
    contest: { id: contestCode, kind: contestCode === "PRACTICE" ? "practice" : "contest" },
  };
}
