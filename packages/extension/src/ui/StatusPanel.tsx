import { describePeriod, PLATFORM_DISPLAY, type Platform } from "@cst/shared";
import type { PopupState } from "../background/handler.js";
import { periodResetsAt, repoUrl } from "./history.js";
import { deriveStatus, STATUS_LABELS } from "./status.js";

/** Current status summary. All platform-derived strings are rendered as text. */
export function StatusPanel(props: {
  state: PopupState;
  onRetry: (key?: string) => void;
  onRetryUpload?: (platform: Platform, submissionId: string) => void;
  /** Injected for tests; defaults to the current time. */
  now?: number;
}) {
  const { state } = props;
  const latest = state.activity[0];
  const status = deriveStatus(latest);
  const resetsAt = periodResetsAt(state.settings, props.now ?? Date.now());
  const repo = repoUrl(state.settings.repo);
  return (
    <section className="status">
      <p className={`badge badge-${status}`} data-testid="status">
        {STATUS_LABELS[status]}
      </p>
      {latest && (
        <p>
          Last: {PLATFORM_DISPLAY[latest.platform]} —{" "}
          {latest.problemTitle || latest.problemKey || latest.submissionId} (
          {latest.rawVerdict ?? latest.verdict})
        </p>
      )}
      {latest?.detail && <p className="detail">{latest.detail}</p>}
      {latest && (status === "failed" || status === "needsAuth") && props.onRetryUpload && (
        <button
          type="button"
          onClick={() => props.onRetryUpload?.(latest.platform, latest.submissionId)}
        >
          Retry upload
        </button>
      )}
      {!state.github.connected && (
        <p className="detail">GitHub is not connected. Open Settings to connect.</p>
      )}
      {!state.settings.autoUpload && (
        <p>Auto-upload is off: accepted solutions wait for “Upload now” below.</p>
      )}
      <p>
        Period: {describePeriod(state.settings.period)}
        {resetsAt !== null &&
          ` · resets ${new Date(resetsAt).toLocaleString(undefined, {
            timeZone: state.settings.timezone,
            dateStyle: "medium",
            timeStyle: "short",
          })} (${state.settings.timezone})`}
      </p>
      <p>
        Uploaded: {state.uploadedCount}
        {repo && (
          <>
            {" · "}
            <a href={repo} target="_blank" rel="noreferrer">
              Open repository
            </a>
          </>
        )}
      </p>
      {state.outbox.length > 0 && (
        <div>
          <p>Pending ({state.outbox.length}):</p>
          <ul>
            {state.outbox.map((o) => (
              <li key={o.key}>
                {PLATFORM_DISPLAY[o.platform]} — {o.problemTitle} · attempts {o.attempts}
                {o.lastError ? ` · ${o.lastError}` : ""}
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => props.onRetry()}>
            Retry now
          </button>
        </div>
      )}
    </section>
  );
}
