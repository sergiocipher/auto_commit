import { z } from "zod";
import {
  buildProblemSlug,
  resolveLanguage,
  sha256Hex,
  type SubmissionEvent,
  type Verdict,
} from "@cst/shared";

export const LEETCODE_ORIGIN = "https://leetcode.com";
export const ACCEPTED_STATUS_CODE = 10;
/** The submission-page fallback only uploads submissions at most this old. */
export const RECENT_SUBMISSION_MS = 15 * 60_000;

// External payloads: parsed leniently (unknown fields allowed), validated on the fields we use.
const CheckSchema = z.looseObject({
  state: z.string(),
  status_code: z.number().optional(),
  status_msg: z.string().optional(),
  lang: z.string().optional(),
  question_id: z.union([z.string(), z.number()]).optional(),
  submission_id: z.union([z.string(), z.number()]).optional(),
  task_finish_time: z.number().optional(),
});

export interface CheckResult {
  final: boolean;
  verdict: Verdict;
  rawVerdict: string;
  submissionId?: string;
  lang?: string;
  questionId?: string;
  finishedAt?: number;
}

export function normalizeVerdict(raw: unknown): Verdict {
  const parsed = CheckSchema.safeParse(raw);
  if (!parsed.success || parsed.data.state !== "SUCCESS") return "PENDING";
  const { status_code, status_msg } = parsed.data;
  const accepted =
    status_code === ACCEPTED_STATUS_CODE && (status_msg === undefined || status_msg === "Accepted");
  return accepted ? "ACCEPTED" : "REJECTED";
}

/** Parses a /submissions/detail/<id>/check/ response body. Returns null if unrecognizable. */
export function parseCheck(raw: unknown): CheckResult | null {
  const parsed = CheckSchema.safeParse(raw);
  if (!parsed.success) return null;
  const c = parsed.data;
  const final = c.state === "SUCCESS";
  return {
    final,
    verdict: normalizeVerdict(raw),
    rawVerdict: final ? (c.status_msg ?? `status ${c.status_code ?? "?"}`) : "Pending",
    ...(c.submission_id !== undefined ? { submissionId: String(c.submission_id) } : {}),
    ...(c.lang ? { lang: c.lang } : {}),
    ...(c.question_id !== undefined ? { questionId: String(c.question_id) } : {}),
    ...(c.task_finish_time ? { finishedAt: c.task_finish_time } : {}),
  };
}

const CHECK_PATH_RE = /^\/submissions\/detail\/(\d+)\/check\/?$/;
const SUBMISSION_PAGE_RE = /^\/problems\/([a-z0-9-]+)\/submissions\/(\d+)\/?$/;
const PROBLEM_PAGE_RE = /^\/problems\/([a-z0-9-]+)(?:\/|$)/;

function leetcodePath(url: string): string | null {
  try {
    const u = new URL(url, LEETCODE_ORIGIN);
    return u.origin === LEETCODE_ORIGIN ? u.pathname : null;
  } catch {
    return null;
  }
}

export function submissionIdFromCheckUrl(url: string): string | null {
  const path = leetcodePath(url);
  return path?.match(CHECK_PATH_RE)?.[1] ?? null;
}

export function submissionFromPageUrl(
  url: string,
): { titleSlug: string; submissionId: string } | null {
  const m = leetcodePath(url)?.match(SUBMISSION_PAGE_RE);
  return m ? { titleSlug: m[1]!, submissionId: m[2]! } : null;
}

export function titleSlugFromUrl(url: string): string | null {
  return leetcodePath(url)?.match(PROBLEM_PAGE_RE)?.[1] ?? null;
}

const DetailsSchema = z.looseObject({
  data: z.looseObject({
    submissionDetails: z
      .looseObject({
        code: z.string(),
        timestamp: z.union([z.string(), z.number()]),
        statusCode: z.number(),
        lang: z.looseObject({ name: z.string(), verboseName: z.string().optional() }),
        question: z.looseObject({
          questionId: z.union([z.string(), z.number()]),
          titleSlug: z.string(),
        }),
      })
      .nullable(),
  }),
});

export interface SubmissionDetails {
  submissionId: string;
  code: string;
  submittedAt: number;
  statusCode: number;
  lang: string;
  questionId: string;
  titleSlug: string;
}

export class LeetCodeParseError extends Error {
  override name = "LeetCodeParseError";
}

/** Parses the submissionDetails GraphQL response for `submissionId`. */
export function parseDetails(raw: unknown, submissionId: string): SubmissionDetails {
  const parsed = DetailsSchema.safeParse(raw);
  if (!parsed.success) throw new LeetCodeParseError("Unrecognized submissionDetails response.");
  const d = parsed.data.data.submissionDetails;
  if (!d)
    throw new LeetCodeParseError(
      "Submission details unavailable (logged out or not your submission?).",
    );
  const seconds = Number(d.timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new LeetCodeParseError("Submission has no valid timestamp.");
  return {
    submissionId,
    code: d.code,
    submittedAt: seconds * 1000,
    statusCode: d.statusCode,
    lang: d.lang.name,
    questionId: String(d.question.questionId),
    titleSlug: d.question.titleSlug,
  };
}

const TitleSchema = z.looseObject({
  data: z.looseObject({
    question: z
      .looseObject({
        title: z.string(),
        questionFrontendId: z.union([z.string(), z.number()]).optional(),
      })
      .nullable(),
  }),
});

export function parseTitle(raw: unknown): { title: string; frontendId?: string } | null {
  const parsed = TitleSchema.safeParse(raw);
  const q = parsed.success ? parsed.data.data.question : null;
  if (!q) return null;
  return {
    title: q.title,
    ...(q.questionFrontendId !== undefined ? { frontendId: String(q.questionFrontendId) } : {}),
  };
}

export interface BuildContext {
  /** Slug from the page URL, if the page has one. */
  pageTitleSlug?: string | null;
  /** Facts from the /check/ payload, if it was seen. */
  check?: Pick<CheckResult, "lang" | "questionId"> | null;
  title?: { title: string; frontendId?: string } | null;
  detectedAt: number;
}

/**
 * Turns verified details into a SubmissionEvent, or explains why not.
 * Never emits unless the details say Accepted, the code is non-empty and the
 * cross-checks against the page and the /check/ payload agree.
 */
export async function buildEvent(
  details: SubmissionDetails,
  ctx: BuildContext,
): Promise<SubmissionEvent> {
  if (details.statusCode !== ACCEPTED_STATUS_CODE)
    throw new LeetCodeParseError("Submission is not accepted.");
  if (details.code.length === 0) throw new LeetCodeParseError("Submission has no source code.");
  if (ctx.pageTitleSlug && ctx.pageTitleSlug !== details.titleSlug) {
    throw new LeetCodeParseError("Submission belongs to a different problem than the page.");
  }
  if (ctx.check?.questionId && ctx.check.questionId !== details.questionId) {
    throw new LeetCodeParseError("Submission details do not match the judged submission.");
  }
  if (ctx.check?.lang && ctx.check.lang !== details.lang) {
    throw new LeetCodeParseError("Submission language does not match the judged submission.");
  }
  let languageNormalized: string | undefined;
  try {
    languageNormalized = resolveLanguage(details.lang).normalized;
  } catch {
    // Unknown here; the uploader reports it (or applies a user override).
  }
  const problemTitle = ctx.title?.title ?? "";
  return {
    platform: "leetcode",
    problemKey: details.titleSlug,
    problemSlug: buildProblemSlug("leetcode", details.titleSlug, problemTitle),
    problemId: ctx.title?.frontendId ?? details.questionId,
    problemTitle,
    problemUrl: `${LEETCODE_ORIGIN}/problems/${details.titleSlug}/`,
    submissionId: details.submissionId,
    language: details.lang,
    ...(languageNormalized ? { languageNormalized } : {}),
    sourceCode: details.code,
    sourceSha256: await sha256Hex(details.code),
    verdict: "ACCEPTED",
    submittedAt: details.submittedAt,
    detectedAt: ctx.detectedAt,
  };
}

export const SUBMISSION_DETAILS_QUERY = `query submissionDetails($submissionId: Int!) {
  submissionDetails(submissionId: $submissionId) {
    code
    timestamp
    statusCode
    lang { name verboseName }
    question { questionId titleSlug }
  }
}`;

export const QUESTION_TITLE_QUERY = `query questionTitle($titleSlug: String!) {
  question(titleSlug: $titleSlug) { questionId questionFrontendId title titleSlug }
}`;
