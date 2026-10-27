import type { Platform } from "./schemas.js";
import { PLATFORMS } from "./schemas.js";

export class InvalidPathError extends Error {
  override name = "InvalidPathError";
}

export const MAX_SLUG_LENGTH = 80;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EXT_RE = /^[a-z0-9]{1,10}$/;

/**
 * Turns arbitrary text into a filesystem- and URL-safe folder segment.
 * Unicode is decomposed and folded to ASCII where possible; everything else
 * (including dots, slashes and backslashes) becomes a hyphen, so traversal
 * sequences cannot survive. Returns "" when nothing usable remains.
 */
export function sanitizeSlug(input: string, maxLength = MAX_SLUG_LENGTH): string {
  const ascii = input
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
  const collapsed = ascii.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return collapsed.slice(0, maxLength).replace(/-+$/g, "");
}

/**
 * Folder slug for a problem. LeetCode's titleSlug is already unique, so it is
 * used alone; Codeforces and CodeChef titles repeat across contests, so the
 * problem key prefixes the title (e.g. "4a-watermelon"). Falls back to the
 * key alone when the title yields nothing.
 */
export function buildProblemSlug(
  platform: Platform,
  problemKey: string,
  problemTitle: string,
): string {
  const keySlug = sanitizeSlug(problemKey);
  const candidate =
    platform === "leetcode" ? keySlug : sanitizeSlug(`${problemKey} ${problemTitle}`);
  const slug = candidate || keySlug;
  if (!slug) throw new InvalidPathError(`cannot derive a slug from problem key "${problemKey}"`);
  return slug;
}

/** Throws unless `path` is a relative, normalized path under `data/`. */
export function assertSafeRepoPath(path: string): void {
  if (path.includes("\\") || path.includes("\0")) {
    throw new InvalidPathError("path contains forbidden characters");
  }
  const segments = path.split("/");
  if (segments[0] !== "data" || segments.length < 2) {
    throw new InvalidPathError("path must be under data/");
  }
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === ".." || seg.startsWith(".")) {
      throw new InvalidPathError(`invalid path segment "${seg}"`);
    }
  }
}

export interface SolutionPathInput {
  platform: Platform;
  problemSlug: string;
  extension: string;
  /** When set, produces `solution-<submissionId>.<ext>` (collision fallback). */
  submissionId?: string;
}

export function problemFolder(platform: Platform, problemSlug: string): string {
  if (!PLATFORMS.includes(platform)) throw new InvalidPathError("unknown platform");
  if (!SLUG_RE.test(problemSlug) || problemSlug.length > MAX_SLUG_LENGTH) {
    throw new InvalidPathError(`invalid problem slug "${problemSlug}"`);
  }
  return `data/${platform}/${problemSlug}`;
}

export function buildSolutionPath(input: SolutionPathInput): string {
  if (!EXT_RE.test(input.extension)) {
    throw new InvalidPathError(`invalid file extension "${input.extension}"`);
  }
  let base = "solution";
  if (input.submissionId !== undefined) {
    const id = input.submissionId.replace(/[^A-Za-z0-9_-]/g, "");
    if (!id) throw new InvalidPathError("submission id has no usable characters");
    base = `solution-${id.slice(0, 64)}`;
  }
  const path = `${problemFolder(input.platform, input.problemSlug)}/${base}.${input.extension}`;
  assertSafeRepoPath(path);
  return path;
}

export function buildMetadataPath(platform: Platform, problemSlug: string): string {
  const path = `${problemFolder(platform, problemSlug)}/metadata.json`;
  assertSafeRepoPath(path);
  return path;
}
