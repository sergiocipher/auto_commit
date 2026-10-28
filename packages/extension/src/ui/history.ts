import { windowBounds, type Settings, type UploadStatus } from "@cst/shared";
import type { UploadSummary } from "../background/handler.js";

/** Short per-row status text for the history list. */
export const HISTORY_STATUS_TEXT: Record<UploadStatus, string> = {
  RECEIVED: "Queued",
  QUEUED: "Queued",
  UPLOADING: "Uploading",
  RETRYING: "Retrying",
  SUCCESS: "Uploaded",
  SKIPPED_DUPLICATE: "Already uploaded this period",
  SKIPPED_NOT_ELIGIBLE: "Already uploaded this period",
  HELD: "Waiting for manual upload",
  FAILED_PERMANENT: "Failed",
  NEEDS_AUTH: "Needs GitHub reconnect",
};

export type UploadAction = "retry" | "upload" | "force";

/**
 * Buttons offered for a history row. Upload and force need the stored
 * source; retry of a job without it is still offered for failed jobs so
 * the user gets the "submit again" explanation.
 */
export function uploadActions(u: UploadSummary): UploadAction[] {
  switch (u.status) {
    case "HELD":
      return u.sourceStored ? ["upload", "force"] : [];
    case "SKIPPED_DUPLICATE":
    case "SKIPPED_NOT_ELIGIBLE":
      return u.sourceStored ? ["force"] : [];
    case "FAILED_PERMANENT":
      return u.sourceStored && !u.force ? ["retry", "force"] : ["retry"];
    case "NEEDS_AUTH":
    case "RETRYING":
      return ["retry"];
    default:
      return [];
  }
}

export function hasRetryableFailures(uploads: readonly UploadSummary[]): boolean {
  return uploads.some((u) => u.status === "FAILED_PERMANENT" || u.status === "NEEDS_AUTH");
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/** https URL of the configured repository, or null when none is set. */
export function repoUrl(repo: Settings["repo"]): string | null {
  if (!NAME.test(repo.owner) || !NAME.test(repo.name)) return null;
  return `https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

/** Link to the commit an upload created, when both parts look valid. */
export function commitUrl(u: Pick<UploadSummary, "repository" | "commitSha">): string | null {
  const [owner = "", name = "", ...rest] = (u.repository ?? "").split("/");
  if (rest.length > 0 || !u.commitSha || !/^[0-9a-f]{40}$/.test(u.commitSha)) return null;
  const repo = repoUrl({ owner, name, branch: "" });
  return repo && `${repo}/commit/${u.commitSha}`;
}

/** When the current calendar period ends (epoch ms); null for rolling and permanent policies. */
export function periodResetsAt(settings: Pick<Settings, "period" | "timezone">, now: number) {
  const { kind } = settings.period;
  if (kind !== "calendar_day" && kind !== "calendar_week" && kind !== "calendar_month") return null;
  return windowBounds(settings.period, now, settings.timezone).end;
}
