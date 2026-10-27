import { useState } from "react";
import { api } from "./api.js";
import type { RepoSummary } from "../background/githubAuth.js";
import {
  PLATFORM_DISPLAY,
  PLATFORMS,
  SettingsSchema,
  type PeriodPolicy,
  type Settings,
} from "@cst/shared";

const PERIOD_KINDS: PeriodPolicy["kind"][] = [
  "calendar_day",
  "rolling_24h",
  "calendar_week",
  "calendar_month",
  "permanent",
  "custom_hours",
];

function periodFor(kind: PeriodPolicy["kind"], prev: PeriodPolicy): PeriodPolicy {
  if (kind === "calendar_week")
    return { kind, weekStartsOn: prev.kind === "calendar_week" ? prev.weekStartsOn : 1 };
  if (kind === "custom_hours")
    return { kind, hours: prev.kind === "custom_hours" ? prev.hours : 12 };
  return { kind };
}

export function SettingsForm(props: {
  initial: Settings;
  githubConnected: boolean;
  onSave: (s: Settings) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Settings>(props.initial);
  const [message, setMessage] = useState<string>("");
  const set = (patch: Partial<Settings>) => setDraft((d) => ({ ...d, ...patch }));

  async function save() {
    const parsed = SettingsSchema.safeParse(draft);
    if (!parsed.success) {
      setMessage(
        `Invalid settings: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
      );
      return;
    }
    try {
      await props.onSave(parsed.data);
      setMessage("Saved.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Save failed.");
    }
  }

  return (
    <form
      className="settings"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label>
        <input
          type="checkbox"
          checked={draft.autoUpload}
          onChange={(e) => set({ autoUpload: e.target.checked })}
        />
        Auto-upload accepted solutions
      </label>
      <label>
        <input
          type="checkbox"
          checked={draft.uploadMetadata}
          onChange={(e) => set({ uploadMetadata: e.target.checked })}
        />
        Upload metadata.json
      </label>
      <fieldset>
        <legend>Platforms</legend>
        {PLATFORMS.map((p) => (
          <label key={p}>
            <input
              type="checkbox"
              checked={draft.enabledPlatforms[p]}
              onChange={(e) =>
                set({ enabledPlatforms: { ...draft.enabledPlatforms, [p]: e.target.checked } })
              }
            />
            {PLATFORM_DISPLAY[p]}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Upload period</legend>
        <select
          value={draft.period.kind}
          onChange={(e) =>
            set({ period: periodFor(e.target.value as PeriodPolicy["kind"], draft.period) })
          }
        >
          {PERIOD_KINDS.map((k) => (
            <option key={k} value={k}>
              {k.replace("_", " ")}
            </option>
          ))}
        </select>
        {draft.period.kind === "calendar_week" && (
          <select
            value={draft.period.weekStartsOn}
            onChange={(e) =>
              set({
                period: { kind: "calendar_week", weekStartsOn: e.target.value === "0" ? 0 : 1 },
              })
            }
          >
            <option value="1">Week starts Monday</option>
            <option value="0">Week starts Sunday</option>
          </select>
        )}
        {draft.period.kind === "custom_hours" && (
          <input
            type="number"
            min={1}
            value={draft.period.hours}
            onChange={(e) =>
              set({ period: { kind: "custom_hours", hours: Number(e.target.value) } })
            }
          />
        )}
        <label>
          Timezone (IANA)
          <input
            value={draft.timezone}
            onChange={(e) => set({ timezone: e.target.value.trim() })}
          />
        </label>
      </fieldset>
      <fieldset>
        <legend>Repository</legend>
        {props.githubConnected && (
          <RepoPicker
            value={draft.repo}
            onPick={(repo) => set({ repo })}
            onError={(m) => setMessage(m)}
          />
        )}
        <input
          placeholder="owner"
          value={draft.repo.owner}
          onChange={(e) => set({ repo: { ...draft.repo, owner: e.target.value.trim() } })}
        />
        <input
          placeholder="repository"
          value={draft.repo.name}
          onChange={(e) => set({ repo: { ...draft.repo, name: e.target.value.trim() } })}
        />
        <input
          placeholder="branch"
          value={draft.repo.branch}
          onChange={(e) => set({ repo: { ...draft.repo, branch: e.target.value.trim() } })}
        />
      </fieldset>
      <button type="submit">Save settings</button>
      {message && <p role="status">{message}</p>}
    </form>
  );
}

function RepoPicker(props: {
  value: Settings["repo"];
  onPick: (repo: Settings["repo"]) => void;
  onError: (message: string) => void;
}) {
  const [repos, setRepos] = useState<RepoSummary[] | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const fail = (e: unknown) =>
    props.onError(e instanceof Error ? e.message : "GitHub request failed.");

  async function pickRepo(fullName: string) {
    const repo = repos?.find((r) => `${r.owner}/${r.name}` === fullName);
    if (!repo) return;
    props.onPick({ owner: repo.owner, name: repo.name, branch: repo.defaultBranch });
    api.branches(repo.owner, repo.name).then(setBranches, fail);
  }

  if (!repos) {
    return (
      <button type="button" onClick={() => api.repos().then(setRepos, fail)}>
        Load my repositories
      </button>
    );
  }
  return (
    <div>
      <select
        value={`${props.value.owner}/${props.value.name}`}
        onChange={(e) => void pickRepo(e.target.value)}
      >
        <option value="/">Choose a repository…</option>
        {repos.map((r) => (
          <option key={`${r.owner}/${r.name}`} value={`${r.owner}/${r.name}`}>
            {r.owner}/{r.name}
            {r.private ? " (private)" : ""}
          </option>
        ))}
      </select>
      {branches.length > 0 && (
        <select
          value={props.value.branch}
          onChange={(e) => props.onPick({ ...props.value, branch: e.target.value })}
        >
          {branches.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
