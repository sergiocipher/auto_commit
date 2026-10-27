import { api } from "../ui/api.js";
import { GitHubPanel } from "../ui/GitHubPanel.js";
import { SettingsForm } from "../ui/SettingsForm.js";
import { useAppState } from "../ui/useAppState.js";

export function App() {
  const { state, error, refresh } = useAppState();
  async function clearData() {
    if (!confirm("Clear pending uploads and history stored in this browser? Settings are kept."))
      return;
    await api.clearData();
    refresh();
  }
  return (
    <main>
      <h1>Coding Submission Tracker — Settings</h1>
      {error && <p className="detail">{error}</p>}
      {state && <GitHubPanel status={state.github} onChange={refresh} />}
      {state ? (
        <SettingsForm
          key={JSON.stringify(state.settings)}
          initial={state.settings}
          githubConnected={state.github.connected}
          onSave={async (s) => {
            await api.saveSettings(s);
          }}
        />
      ) : (
        <p>Loading…</p>
      )}
      <button type="button" onClick={() => void clearData()}>
        Clear local data
      </button>
    </main>
  );
}
