import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  BRIDGE_TAG,
  listenFromPage,
  postToIsolated,
  type BridgeWindow,
} from "../src/content/bridge.js";

function fakeWindow(origin = "https://leetcode.com") {
  const target = new EventTarget();
  const win: BridgeWindow & {
    dispatch(data: unknown, opts?: { origin?: string; source?: unknown }): void;
  } = {
    location: { origin },
    addEventListener: (type, listener, opts) =>
      target.addEventListener(type, listener as EventListener, opts),
    postMessage: (message, targetOrigin) => {
      if (targetOrigin !== origin) throw new Error("wrong target origin");
      win.dispatch(message);
    },
    dispatch(data, opts = {}) {
      const ev = new Event("message") as MessageEvent;
      Object.defineProperties(ev, {
        data: { value: data },
        origin: { value: opts.origin ?? origin },
        source: { value: "source" in opts ? opts.source : win },
      });
      target.dispatchEvent(ev);
    },
  };
  return win;
}

const Payload = z.strictObject({ id: z.string() });

describe("page bridge", () => {
  it("delivers valid messages posted by the page itself", () => {
    const win = fakeWindow();
    const handler = vi.fn();
    listenFromPage(win, "lc", Payload, handler);
    postToIsolated(win, "lc", { id: "1" });
    expect(handler).toHaveBeenCalledWith({ id: "1" });
  });

  it.each([
    [
      "wrong origin",
      { tag: BRIDGE_TAG, channel: "lc", payload: { id: "1" } },
      { origin: "https://evil.example" },
    ],
    [
      "other source window",
      { tag: BRIDGE_TAG, channel: "lc", payload: { id: "1" } },
      { source: {} },
    ],
    ["missing tag", { channel: "lc", payload: { id: "1" } }, {}],
    ["other channel", { tag: BRIDGE_TAG, channel: "cf", payload: { id: "1" } }, {}],
    ["bad payload", { tag: BRIDGE_TAG, channel: "lc", payload: { id: 1 } }, {}],
    ["extra fields", { tag: BRIDGE_TAG, channel: "lc", payload: { id: "1", x: 1 } }, {}],
    ["non-object", "hello", {}],
  ])("ignores %s", (_label, data, opts) => {
    const win = fakeWindow();
    const handler = vi.fn();
    listenFromPage(win, "lc", Payload, handler);
    win.dispatch(data, opts);
    expect(handler).not.toHaveBeenCalled();
  });

  it("stops listening when aborted", () => {
    const win = fakeWindow();
    const handler = vi.fn();
    const ac = new AbortController();
    listenFromPage(win, "lc", Payload, handler, ac.signal);
    ac.abort();
    postToIsolated(win, "lc", { id: "1" });
    expect(handler).not.toHaveBeenCalled();
  });
});
