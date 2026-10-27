import { sha256Hex, SubmissionEventSchema, type SubmissionEvent } from "@cst/shared";

export class InvalidSubmissionError extends Error {
  override name = "InvalidSubmissionError";
}

/**
 * The upload gate: schema-valid, ACCEPTED, non-empty source whose SHA-256
 * matches the hash computed when it was captured. Run at every trust
 * boundary (service worker, backend), not just once.
 */
export async function assertUploadable(raw: unknown): Promise<SubmissionEvent> {
  const parsed = SubmissionEventSchema.safeParse(raw);
  if (!parsed.success) throw new InvalidSubmissionError("Submission event failed validation.");
  const event = parsed.data;
  if (event.verdict !== "ACCEPTED")
    throw new InvalidSubmissionError("Only accepted submissions are uploaded.");
  if (event.sourceCode.length === 0)
    throw new InvalidSubmissionError("Submission has no source code.");
  if ((await sha256Hex(event.sourceCode)) !== event.sourceSha256) {
    throw new InvalidSubmissionError(
      "Source code hash mismatch; the code may have been altered or truncated.",
    );
  }
  return event;
}
