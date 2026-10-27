import { z } from "zod";
import {
  buildProblemSlug,
  resolveLanguage,
  sha256Hex,
  type SubmissionEvent,
  type Verdict,
} from "@cst/shared";

export const CODEFORCES_ORIGIN = "https://codeforces.com";

export type ContestKind = "contest" | "gym" | "problemset";

export interface StatusRow {
  submissionId: string;
  /** Absolute URL of the submission page (from the row's ID link). */
  submissionUrl: string;
  authorHandle: string | null;
  contestId: string;
  problemIndex: string;
  problemName: string;
  problemUrl: string;
  contestKind: ContestKind;
  /** Group id for group contests (contestKind "gym" with a group prefix). */
  groupId?: string;
  language: string;
  verdict: Verdict;
  rawVerdict: string;
}

// Values of the submissionverdict attribute; anything else final is REJECTED.
const PENDING_CODES = new Set(["TESTING", "SUBMITTED", ""]);

/**
 * Verdict from a verdict cell. Accepted requires the machine-readable
 * submissionverdict="OK" (or, if that attribute is absent, the
 * verdict-accepted class); a waiting cell is always PENDING.
 */
export function normalizeVerdict(raw: unknown): Verdict {
  if (!raw || typeof raw !== "object" || !("querySelector" in raw)) return "PENDING";
  const cell = raw as Element;
  if (cell.getAttribute("waiting") === "true") return "PENDING";
  const wrapper = cell.querySelector("[submissionverdict]");
  const code = wrapper?.getAttribute("submissionverdict");
  if (code !== undefined && code !== null) {
    if (PENDING_CODES.has(code)) return "PENDING";
    return code === "OK" ? "ACCEPTED" : "REJECTED";
  }
  if (cell.querySelector(".verdict-waiting")) return "PENDING";
  if (cell.querySelector(".verdict-accepted")) return "ACCEPTED";
  if (cell.querySelector(".verdict-rejected, .verdict-failed")) return "REJECTED";
  return "PENDING";
}

const PROBLEM_PATHS: ReadonlyArray<{ re: RegExp; kind: ContestKind; group?: boolean }> = [
  { re: /^\/contest\/(\d+)\/problem\/([A-Za-z0-9]+)\/?$/, kind: "contest" },
  { re: /^\/problemset\/problem\/(\d+)\/([A-Za-z0-9]+)\/?$/, kind: "problemset" },
  { re: /^\/gym\/(\d+)\/problem\/([A-Za-z0-9]+)\/?$/, kind: "gym" },
  {
    re: /^\/group\/([A-Za-z0-9]+)\/contest\/(\d+)\/problem\/([A-Za-z0-9]+)\/?$/,
    kind: "gym",
    group: true,
  },
];

export function parseProblemHref(
  href: string,
): { contestId: string; index: string; kind: ContestKind; groupId?: string; url: string } | null {
  let u: URL;
  try {
    u = new URL(href, CODEFORCES_ORIGIN);
  } catch {
    return null;
  }
  if (u.origin !== CODEFORCES_ORIGIN) return null;
  for (const { re, kind, group } of PROBLEM_PATHS) {
    const m = u.pathname.match(re);
    if (!m) continue;
    const [contestId, index] = group ? [m[2]!, m[3]!] : [m[1]!, m[2]!];
    return {
      contestId,
      index: index.toUpperCase(),
      kind,
      ...(group ? { groupId: m[1]! } : {}),
      url: `${CODEFORCES_ORIGIN}${u.pathname.replace(/\/$/, "")}`,
    };
  }
  return null;
}

const SUBMISSION_PATH_RE =
  /^\/(?:contest\/\d+\/submission|gym\/\d+\/submission|group\/[A-Za-z0-9]+\/contest\/\d+\/submission|problemset\/submission\/\d+)\/(\d+)\/?$/;

export function submissionIdFromHref(href: string): string | null {
  try {
    const u = new URL(href, CODEFORCES_ORIGIN);
    return u.origin === CODEFORCES_ORIGIN
      ? (u.pathname.match(SUBMISSION_PATH_RE)?.[1] ?? null)
      : null;
  } catch {
    return null;
  }
}

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** "A - Watermelon" or "4A - Watermelon" -> "Watermelon". */
function problemNameFromCell(cellText: string): string {
  const i = cellText.indexOf(" - ");
  return i === -1 ? "" : cellText.slice(i + 3).trim();
}

/**
 * Parses status-table rows (contest/gym/group "my" and "status" pages,
 * problemset status, profile submissions). Rows that cannot be fully
 * understood are skipped rather than guessed.
 */
export function parseStatusRows(root: ParentNode): StatusRow[] {
  const rows: StatusRow[] = [];
  for (const tr of Array.from(
    root.querySelectorAll("table.status-frame-datatable tr[data-submission-id]"),
  )) {
    const submissionId = tr.getAttribute("data-submission-id") ?? "";
    if (!/^\d+$/.test(submissionId)) continue;
    const idLink = Array.from(tr.querySelectorAll("a[href]")).find(
      (a) => submissionIdFromHref(a.getAttribute("href") ?? "") === submissionId,
    );
    const problemLink = Array.from(tr.querySelectorAll("td a[href]")).find((a) =>
      parseProblemHref(a.getAttribute("href") ?? ""),
    );
    const verdictCell = tr.querySelector("td.status-verdict-cell");
    if (!idLink || !problemLink || !verdictCell) continue;
    const problem = parseProblemHref(problemLink.getAttribute("href")!)!;
    const cells = Array.from(tr.querySelectorAll("td"));
    const verdictIdx = cells.indexOf(verdictCell as HTMLTableCellElement);
    // The language column sits immediately before the verdict column.
    const language = verdictIdx > 0 ? text(cells[verdictIdx - 1]) : "";
    if (!language) continue;
    const author = tr.querySelector('td a[href^="/profile/"]');
    rows.push({
      submissionId,
      submissionUrl: new URL(idLink.getAttribute("href")!, CODEFORCES_ORIGIN).href,
      authorHandle: author
        ? decodeURIComponent(author.getAttribute("href")!.slice("/profile/".length))
        : null,
      contestId: problem.contestId,
      problemIndex: problem.index,
      problemName: problemNameFromCell(text(problemLink)),
      problemUrl: problem.url,
      contestKind: problem.kind,
      ...(problem.groupId ? { groupId: problem.groupId } : {}),
      language,
      verdict: normalizeVerdict(verdictCell),
      rawVerdict: text(verdictCell) || "Pending",
    });
  }
  return rows;
}

/** Handle of the logged-in user from the page header, or null when logged out. */
export function currentHandle(doc: ParentNode): string | null {
  const link = doc.querySelector('.lang-chooser a[href^="/profile/"]');
  const href = link?.getAttribute("href");
  return href ? decodeURIComponent(href.slice("/profile/".length)) : null;
}

export function csrfToken(doc: ParentNode): string | null {
  return (
    doc.querySelector('meta[name="X-Csrf-Token"]')?.getAttribute("content") ??
    doc.querySelector('input[name="csrf_token"]')?.getAttribute("value") ??
    null
  );
}

export class CodeforcesParseError extends Error {
  override name = "CodeforcesParseError";
}

const SubmitSourceSchema = z.looseObject({ source: z.string() });

/** Parses the JSON from POST /data/submitSource (exact bytes, CRLF preserved). */
export function parseSubmitSource(raw: unknown): string {
  const parsed = SubmitSourceSchema.safeParse(raw);
  if (!parsed.success) throw new CodeforcesParseError("Unrecognized submitSource response.");
  return parsed.data.source;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === "#") {
      const cp =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[body] ?? m;
  });
}

/**
 * Extracts source from submission-page HTML **text** (not a parsed DOM:
 * HTML parsing would normalize CRLF to LF and lose byte-exactness).
 */
export function extractSourceFromSubmissionHtml(html: string): string {
  const m = /<pre[^>]*\bid=["']program-source-text["'][^>]*>([\s\S]*?)<\/pre>/i.exec(html);
  if (!m)
    throw new CodeforcesParseError(
      "No source code on the submission page (logged out or not visible?).",
    );
  let body = m[1]!;
  // The HTML spec drops one newline directly after <pre>; mirror that.
  if (body.startsWith("\r\n")) body = body.slice(2);
  else if (body.startsWith("\n")) body = body.slice(1);
  if (/<[a-z]/i.test(body))
    throw new CodeforcesParseError("Submission source is not plain text (highlighted markup).");
  return decodeHtmlEntities(body);
}

export interface BuildContext {
  /** When the row was first seen pending (close to submission time); else detection time. */
  submittedAt: number;
  detectedAt: number;
}

export async function buildEvent(
  row: StatusRow,
  source: string,
  ctx: BuildContext,
): Promise<SubmissionEvent> {
  if (row.verdict !== "ACCEPTED") throw new CodeforcesParseError("Submission is not accepted.");
  if (source.length === 0) throw new CodeforcesParseError("Submission has no source code.");
  const problemKey = `${row.contestId}${row.problemIndex}`;
  let languageNormalized: string | undefined;
  try {
    languageNormalized = resolveLanguage(row.language).normalized;
  } catch {
    // reported by the uploader, or mapped by a user override
  }
  return {
    platform: "codeforces",
    problemKey,
    problemSlug: buildProblemSlug("codeforces", problemKey, row.problemName),
    problemId: problemKey,
    problemTitle: row.problemName,
    problemUrl: row.problemUrl,
    submissionId: row.submissionId,
    language: row.language,
    ...(languageNormalized ? { languageNormalized } : {}),
    sourceCode: source,
    sourceSha256: await sha256Hex(source),
    verdict: "ACCEPTED",
    submittedAt: ctx.submittedAt,
    detectedAt: ctx.detectedAt,
    contest: {
      id: row.groupId ? `${row.groupId}/${row.contestId}` : row.contestId,
      kind: row.contestKind,
    },
  };
}
