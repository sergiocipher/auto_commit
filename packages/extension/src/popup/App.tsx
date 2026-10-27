import { api } from "../ui/api.js";
import { StatusPanel } from "../ui/StatusPanel.js";
import { useAppState } from "../ui/useAppState.js";

export function App() {
  const { state, error, refresh } = useAppState();
  return (
    <main>
      <h1>Submission Tracker</h1>
      {error && <p className="detail">{error}</p>}
      {state ? (
        <StatusPanel state={state} onRetry={(key) => void api.retry(key).then(refresh)} />
      ) : (
        <p>Loading…</p>
      )}
      <button type="button" onClick={() => void chrome.runtime.openOptionsPage()}>
        Settings
      </button>
    </main>
  );
}
