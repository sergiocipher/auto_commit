import { createCodeChefAdapter } from "../adapters/codechef/adapter.js";
import { runAdapter } from "./runner.js";

const controller = new AbortController();
const adapter = createCodeChefAdapter({
  win: window,
  fetch: (url, init) => fetch(url, init),
  now: Date.now,
  log: (m) => console.debug(`[submission-tracker] ${m}`),
});

runAdapter(
  adapter,
  location.href,
  (message) => {
    try {
      return chrome.runtime.sendMessage(message);
    } catch (err) {
      controller.abort();
      return Promise.reject(err instanceof Error ? err : new Error("send failed"));
    }
  },
  controller.signal,
);
