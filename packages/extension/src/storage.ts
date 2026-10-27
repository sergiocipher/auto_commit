/** Minimal async key-value store; chrome.storage.local in production, in-memory in tests. */
export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export function chromeLocalStore(
  area: chrome.storage.StorageArea = chrome.storage.local,
): KeyValueStore {
  return {
    async get(key) {
      const out = await area.get(key);
      return out[key];
    },
    async set(key, value) {
      await area.set({ [key]: value });
    },
    async remove(key) {
      await area.remove(key);
    },
  };
}
