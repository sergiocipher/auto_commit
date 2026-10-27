import { z } from "zod";
import type { LanguageInfo, SubmissionEvent } from "@cst/shared";

const SolutionEntrySchema = z.looseObject({
  file: z.string(),
  submissionId: z.string(),
  language: z.string(),
  languageNormalized: z.string(),
  submittedAt: z.string(),
  uploadedAt: z.string(),
  sourceSha256: z.string(),
});

/** metadata.json, one per problem folder. Unknown fields (user edits) are preserved. */
export const ProblemMetadataFileSchema = z.looseObject({
  schemaVersion: z.literal(1),
  platform: z.string(),
  problemKey: z.string(),
  problemTitle: z.string(),
  problemUrl: z.string(),
  problemId: z.string().optional(),
  contest: z.looseObject({ id: z.string(), kind: z.string() }).optional(),
  solutions: z.record(z.string(), SolutionEntrySchema),
});
export type ProblemMetadataFile = z.infer<typeof ProblemMetadataFileSchema>;

export class MetadataConflictError extends Error {
  override name = "MetadataConflictError";
}

/** Key for one solution inside metadata.json: language + submission. */
export function solutionEntryKey(languageNormalized: string, submissionId: string): string {
  return `${languageNormalized}:${submissionId}`;
}

/**
 * Read-modify-write merge. Contains no credentials: only problem facts and
 * per-solution submission facts. Throws if the existing file describes a
 * different problem (folder collision), so nothing unrelated is touched.
 */
export function mergeMetadata(
  existing: ProblemMetadataFile | null,
  event: SubmissionEvent,
  language: LanguageInfo,
  fileName: string,
  uploadedAt: number,
): ProblemMetadataFile {
  if (
    existing &&
    (existing.platform !== event.platform || existing.problemKey !== event.problemKey)
  ) {
    throw new MetadataConflictError(
      `metadata.json in this folder belongs to ${existing.platform}/${existing.problemKey}, not ${event.platform}/${event.problemKey}`,
    );
  }
  const base: ProblemMetadataFile = existing ?? {
    schemaVersion: 1,
    platform: event.platform,
    problemKey: event.problemKey,
    problemTitle: event.problemTitle,
    problemUrl: event.problemUrl,
    solutions: {},
  };
  return {
    ...base,
    problemTitle: event.problemTitle || base.problemTitle,
    problemUrl: event.problemUrl,
    ...(event.problemId ? { problemId: event.problemId } : {}),
    ...(event.contest ? { contest: event.contest } : {}),
    solutions: {
      ...base.solutions,
      [solutionEntryKey(language.normalized, event.submissionId)]: {
        file: fileName,
        submissionId: event.submissionId,
        language: event.language,
        languageNormalized: language.normalized,
        submittedAt: new Date(event.submittedAt).toISOString(),
        uploadedAt: new Date(uploadedAt).toISOString(),
        sourceSha256: event.sourceSha256,
      },
    },
  };
}

export function serializeMetadata(m: ProblemMetadataFile): string {
  return `${JSON.stringify(m, null, 2)}\n`;
}
