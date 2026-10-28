import type { UploadSummary } from "../background/handler.js";
import { api } from "../ui/api.js";
import { HistoryPanel } from "../ui/HistoryPanel.js";
import type { UploadAction } from "../ui/history.js";
import { StatusPanel } from "../ui/StatusPanel.js";
import { useAppState } from "../ui/useAppState.js";

export function App() {
  const { state, error, refresh } = useAppState();
  function onAction(action: UploadAction, u: UploadSummary) {
    if (
      action === "force" &&
      !confirm(
        "Force upload ignores the upload period and adds this solution even though one was already uploaded. Continue?",
      )
    )
      return;
    const run = action === "force" ? api.forceUpload : api.retryUpload;
    void run(u.platform, u.submissionId).then(refresh, refresh);
  }
  return (
    <main>
      <h1>Submission Tracker</h1>
      {error && <p className="detail">{error}</p>}
      {state ? (
        <>
          <StatusPanel
            state={state}
            onRetry={(key) => void api.retry(key).then(refresh)}
            onRetryUpload={(platform, id) =>
              void api.retryUpload(platform, id).then(refresh, refresh)
            }
          />
          <HistoryPanel
            uploads={state.uploads}
            onAction={onAction}
            onRetryFailed={() => void api.retryFailedUploads().then(refresh, refresh)}
          />
        </>
      ) : (
        <p>Loading…</p>
      )}
      <button type="button" onClick={() => void chrome.runtime.openOptionsPage()}>
        Settings
      </button>
    </main>
  );
}
