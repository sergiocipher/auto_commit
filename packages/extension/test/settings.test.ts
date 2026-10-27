import { describe, expect, it } from "vitest";
import { SettingsStore, SETTINGS_STORAGE_KEY } from "../src/background/settings.js";
import { MemoryStore } from "./helpers.js";

describe("SettingsStore", () => {
  it("returns defaults with the detected timezone on first run", async () => {
    const s = new SettingsStore(new MemoryStore(), () => "Asia/Kolkata");
    expect((await s.get()).timezone).toBe("Asia/Kolkata");
    expect((await s.get()).period).toEqual({ kind: "calendar_day" });
  });

  it("persists across instances (service worker restart)", async () => {
    const store = new MemoryStore();
    const a = new SettingsStore(store, () => "UTC");
    await a.set({ ...a.defaults(), autoUpload: false });
    expect((await new SettingsStore(store, () => "UTC").get()).autoUpload).toBe(false);
  });

  it("falls back to defaults when stored settings are corrupt", async () => {
    const store = new MemoryStore();
    await store.set(SETTINGS_STORAGE_KEY, { autoUpload: "yes" });
    expect((await new SettingsStore(store, () => "UTC").get()).autoUpload).toBe(true);
  });

  it("refuses to store invalid settings", async () => {
    const s = new SettingsStore(new MemoryStore(), () => "UTC");
    await expect(s.set({ ...s.defaults(), timezone: "Bad/Zone" })).rejects.toThrow();
  });
});
