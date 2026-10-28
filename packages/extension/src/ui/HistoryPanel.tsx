import { PLATFORM_DISPLAY } from "@cst/shared";
import type { UploadSummary } from "../background/handler.js";
import {
  commitUrl,
  hasRetryableFailures,
  HISTORY_STATUS_TEXT,
  uploadActions,
  type UploadAction,
} from "./history.js";

const ACTION_LABELS: Record<UploadAction, string> = {
  retry: "Retry",
  upload: "Upload now",
  force: "Force upload",
};

/** Upload history with per-row actions. All platform-derived strings are rendered as text. */
export function HistoryPanel(props: {
  uploads: UploadSummary[];
  onAction: (action: UploadAction, upload: UploadSummary) => void;
  onRetryFailed: () => void;
}) {
  if (props.uploads.length === 0) return null;
  return (
    <details className="history" open={hasRetryableFailures(props.uploads)}>
      <summary>Upload history ({props.uploads.length})</summary>
      {hasRetryableFailures(props.uploads) && (
        <button type="button" onClick={props.onRetryFailed}>
          Retry all failed
        </button>
      )}
      <ul>
        {props.uploads.map((u) => {
          const link = u.status === "SUCCESS" ? commitUrl(u) : null;
          return (
            <li key={u.id} data-status={u.status}>
              <span>
                {PLATFORM_DISPLAY[u.platform]} — {u.problemTitle || u.problemKey} ({u.language})
              </span>{" "}
              <span className={`row-status row-${u.status}`}>
                {HISTORY_STATUS_TEXT[u.status]}
                {u.force ? " (forced)" : ""}
              </span>
              {u.filePath && u.status === "SUCCESS" && <span className="path"> {u.filePath}</span>}
              {link && (
                <>
                  {" "}
                  <a href={link} target="_blank" rel="noreferrer">
                    commit
                  </a>
                </>
              )}
              {u.lastError && u.status !== "SUCCESS" && <p className="detail">{u.lastError}</p>}
              {uploadActions(u).map((action) => (
                <button key={action} type="button" onClick={() => props.onAction(action, u)}>
                  {ACTION_LABELS[action]}
                </button>
              ))}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
