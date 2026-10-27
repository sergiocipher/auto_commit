// Page-world network observer for LeetCode's submission-check polling.
// It observes and never modifies responses; every failure is swallowed so the
// page behaves exactly as it would without the extension.
import { postToIsolated, type BridgeWindow } from "../../content/bridge.js";
import { CHECK_URL_RE, LEETCODE_CHECK_CHANNEL } from "./channel.js";

export interface HookWindow extends BridgeWindow {
  location: { origin: string; href: string };
  fetch: typeof fetch;
  XMLHttpRequest: { prototype: XMLHttpRequest };
}

export function installCheckHook(win: HookWindow): void {
  const relay = (url: string, text: string) => {
    try {
      postToIsolated(win, LEETCODE_CHECK_CHANNEL, { url, body: JSON.parse(text) as unknown });
    } catch {
      // not JSON
    }
  };
  const isCheck = (url: string) => {
    try {
      const u = new URL(url, win.location.href);
      return u.origin === win.location.origin && CHECK_URL_RE.test(u.pathname + u.search);
    } catch {
      return false;
    }
  };

  const originalFetch = win.fetch;
  win.fetch = async function (this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
    const response = await originalFetch.apply(this, args);
    try {
      const input = args[0];
      const url =
        response.url ||
        (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (isCheck(url)) {
        response
          .clone()
          .text()
          .then(
            (t) => relay(url, t),
            () => undefined,
          );
      }
    } catch {
      // ignore
    }
    return response;
  };

  const proto = win.XMLHttpRequest.prototype;
  const originalOpen = proto.open as (...a: unknown[]) => void;
  proto.open = function (this: XMLHttpRequest, ...args: unknown[]) {
    try {
      const url = String(args[1]);
      if (isCheck(url)) {
        this.addEventListener("load", () => {
          try {
            if (this.responseType === "" || this.responseType === "text")
              relay(url, this.responseText);
            else if (this.responseType === "json") relay(url, JSON.stringify(this.response));
          } catch {
            // ignore
          }
        });
      }
    } catch {
      // ignore
    }
    return originalOpen.apply(this, args);
  } as typeof proto.open;
}
