import { DEFAULT_SETTINGS, isValidTimeZone, SettingsSchema, type Settings } from "@cst/shared";
import type { KeyValueStore } from "../storage.js";

export const SETTINGS_STORAGE_KEY = "settings:v1";

export function detectTimeZone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz && isValidTimeZone(tz) ? tz : "UTC";
}

/** Settings persisted in chrome.storage.local, always returned fully validated. */
export class SettingsStore {
  constructor(
    private readonly store: KeyValueStore,
    private readonly defaultTimeZone: () => string = detectTimeZone,
  ) {}

  defaults(): Settings {
    return { ...DEFAULT_SETTINGS, timezone: this.defaultTimeZone() };
  }

  async get(): Promise<Settings> {
    const stored = await this.store.get(SETTINGS_STORAGE_KEY);
    if (stored === undefined) return this.defaults();
    const parsed = SettingsSchema.safeParse(stored);
    // Corrupt or outdated settings fall back to defaults rather than breaking detection.
    return parsed.success ? parsed.data : this.defaults();
  }

  async set(settings: Settings): Promise<Settings> {
    const valid = SettingsSchema.parse(settings);
    await this.store.set(SETTINGS_STORAGE_KEY, valid);
    return valid;
  }
}
