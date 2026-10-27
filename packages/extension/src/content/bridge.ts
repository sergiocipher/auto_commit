import type { z } from "zod";

/**
 * Page-world <-> isolated-world messaging over window.postMessage.
 * Page scripts are untrusted (any site script can post messages), so the
 * receiver checks source window, origin, envelope tag, channel and payload
 * shape before handing anything on.
 */
export const BRIDGE_TAG = "cst-bridge-v1";

export interface BridgeWindow {
  postMessage(message: unknown, targetOrigin: string): void;
  addEventListener(
    type: "message",
    listener: (ev: MessageEvent) => void,
    opts?: { signal?: AbortSignal },
  ): void;
  location: { origin: string };
}

export function postToIsolated(win: BridgeWindow, channel: string, payload: unknown): void {
  win.postMessage({ tag: BRIDGE_TAG, channel, payload }, win.location.origin);
}

export function listenFromPage<S extends z.ZodType>(
  win: BridgeWindow,
  channel: string,
  schema: S,
  handler: (payload: z.infer<S>) => void,
  signal?: AbortSignal,
): void {
  win.addEventListener(
    "message",
    (ev: MessageEvent) => {
      if (ev.source !== (win as unknown) || ev.origin !== win.location.origin) return;
      const data: unknown = ev.data;
      if (typeof data !== "object" || data === null) return;
      const env = data as { tag?: unknown; channel?: unknown; payload?: unknown };
      if (env.tag !== BRIDGE_TAG || env.channel !== channel) return;
      const parsed = schema.safeParse(env.payload);
      if (parsed.success) handler(parsed.data);
    },
    signal ? { signal } : undefined,
  );
}
