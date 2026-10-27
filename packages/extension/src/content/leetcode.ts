import { createLeetCodeAdapter } from "../adapters/leetcode/adapter.js";
import { runAdapter } from "./runner.js";

const controller = new AbortController();
const adapter = createLeetCodeAdapter({
  win: window,
  fetch: (url, init) => fetch(url, init),
  now: Date.now,
  csrfToken: () => /(?:^|;\s*)csrftoken=([^;]+)/.exec(document.cookie)?.[1],
  log: (m) => console.debug(`[submission-tracker] ${m}`),
});

runAdapter(
  adapter,
  location.href,
  (message) => {
    try {
      return chrome.runtime.sendMessage(message);
    } catch (err) {
      // Extension was reloaded or removed: stop observing this page.
      controller.abort();
      return Promise.reject(err instanceof Error ? err : new Error("send failed"));
    }
  },
  controller.signal,
);
