import { describePeriod, PLATFORM_DISPLAY } from "@cst/shared";
import type { PopupState } from "../background/handler.js";
import { deriveStatus, STATUS_LABELS } from "./status.js";

/** Read-only status view. All platform-derived strings are rendered as text. */
export function StatusPanel(props: { state: PopupState; onRetry: (key?: string) => void }) {
  const { state } = props;
  const latest = state.activity[0];
  const status = deriveStatus(latest);
  const uploaded = state.activity.filter((e) => e.status === "SUCCESS").length;
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
      <p>Period: {describePeriod(state.settings.period)}</p>
      <p>Uploaded (recent): {uploaded}</p>
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
      {state.activity.length > 0 && (
        <details>
          <summary>Recent history</summary>
          <ul>
            {state.activity.map((e) => (
              <li key={e.key}>
                {PLATFORM_DISPLAY[e.platform]} — {e.problemTitle || e.problemKey || e.submissionId}:{" "}
                {e.status ?? e.verdict}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
