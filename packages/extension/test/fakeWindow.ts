import type { BridgeWindow } from "../src/content/bridge.js";

/** Minimal window: postMessage dispatches MessageEvents to listeners with source/origin set. */
export function fakeWindow(href = "https://leetcode.com/problems/two-sum/") {
  const target = new EventTarget();
  const location = { origin: new URL(href).origin, href };
  const win: BridgeWindow & {
    location: { origin: string; href: string };
    dispatch(data: unknown, opts?: { origin?: string; source?: unknown }): void;
  } = {
    location,
    addEventListener: (type, listener, opts) =>
      target.addEventListener(type, listener as EventListener, opts),
    postMessage: (message, targetOrigin) => {
      if (targetOrigin !== location.origin) throw new Error("wrong target origin");
      queueMicrotask(() => win.dispatch(message));
    },
    dispatch(data, opts = {}) {
      const ev = new Event("message") as MessageEvent;
      Object.defineProperties(ev, {
        data: { value: data },
        origin: { value: opts.origin ?? location.origin },
        source: { value: "source" in opts ? opts.source : win },
      });
      target.dispatchEvent(ev);
    },
  };
  return win;
}

export const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
