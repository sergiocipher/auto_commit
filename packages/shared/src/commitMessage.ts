import type { Platform } from "./schemas.js";
import { PLATFORM_DISPLAY } from "./schemas.js";

export const UNKNOWN_PROBLEM = "Unknown Problem";
export const COMMIT_MESSAGE_TARGET_LENGTH = 100;
const MIN_TITLE_CHARS = 12;

/** Collapses whitespace and strips control/format characters (single line). */
export function cleanInline(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface CommitMessageInput {
  platform: Platform;
  problemTitle: string;
  problemKey: string;
  languageDisplay: string;
}

/**
 * `feat(solutions): add <Platform> - <Problem> (<Language>)`
 *
 * The problem key prefixes the title for Codeforces and CodeChef (their
 * titles repeat across contests) and whenever the title is missing.
 * The title is truncated with "..." to keep the line within 100 characters.
 */
export function buildCommitMessage(input: CommitMessageInput): string {
  const title = cleanInline(input.problemTitle);
  const key = cleanInline(input.problemKey);
  const lang = cleanInline(input.languageDisplay) || "Unknown Language";
  const prefixKey = !title || input.platform !== "leetcode";
  let name = title || UNKNOWN_PROBLEM;
  if (prefixKey && key) name = `${key} ${name}`;

  const head = `feat(solutions): add ${PLATFORM_DISPLAY[input.platform]} - `;
  const tail = ` (${lang})`;
  const budget = Math.max(
    MIN_TITLE_CHARS,
    COMMIT_MESSAGE_TARGET_LENGTH - head.length - tail.length,
  );
  const chars = Array.from(name);
  if (chars.length > budget)
    name = `${chars
      .slice(0, budget - 3)
      .join("")
      .trimEnd()}...`;
  return `${head}${name}${tail}`;
}
