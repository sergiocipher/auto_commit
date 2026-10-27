import { useState } from "react";
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

export function SettingsForm(props: { initial: Settings; onSave: (s: Settings) => Promise<void> }) {
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
