import type { ActivityEntry } from "../background/activity.js";

export const STATUS_LABELS = {
  waiting: "Waiting for submission",
  accepted: "Submission accepted",
  uploading: "Uploading to GitHub",
  success: "Upload successful",
  alreadyUploaded: "Already uploaded during this period",
  failed: "Upload failed — retry available",
  needsAuth: "Needs GitHub reconnect",
} as const;
export type StatusKey = keyof typeof STATUS_LABELS;

/**
 * Status for the most recent submission. "Upload successful" is only ever
 * derived from a SUCCESS status reported by the sink, never inferred.
 */
export function deriveStatus(latest: ActivityEntry | undefined): StatusKey {
  if (!latest) return "waiting";
  switch (latest.status) {
    case "SUCCESS":
      return "success";
    case "SKIPPED_DUPLICATE":
    case "SKIPPED_NOT_ELIGIBLE":
      return "alreadyUploaded";
    case "FAILED_PERMANENT":
      return "failed";
    case "NEEDS_AUTH":
      return "needsAuth";
    case "RECEIVED":
    case "QUEUED":
    case "UPLOADING":
    case "RETRYING":
      return "uploading";
    case undefined:
      return latest.verdict === "ACCEPTED" ? "accepted" : "waiting";
  }
}
