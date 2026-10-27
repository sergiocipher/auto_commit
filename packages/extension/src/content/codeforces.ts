import { createCodeforcesAdapter } from "../adapters/codeforces/adapter.js";
import { runAdapter } from "./runner.js";

const controller = new AbortController();
const adapter = createCodeforcesAdapter({
  doc: document,
  fetch: (url, init) => fetch(url, init),
  now: Date.now,
  referrer: document.referrer,
  // Verdict cells are updated live by Codeforces; re-scan (debounced) on DOM changes.
  observe: (onChange, signal) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(onChange, 250);
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    signal.addEventListener("abort", () => {
      observer.disconnect();
      clearTimeout(timer);
    });
  },
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
