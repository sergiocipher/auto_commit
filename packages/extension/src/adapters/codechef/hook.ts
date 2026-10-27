// Page-world observer for CodeChef's IDE submit and verdict polling.
// Observes and never modifies requests or responses; never relays source
// code. Every failure is swallowed so the page behaves as without us.
import { postToIsolated, type BridgeWindow } from "../../content/bridge.js";
import { CODECHEF_RESULT_CHANNEL, CODECHEF_SUBMIT_CHANNEL, SUBMIT_PATH } from "./channel.js";

export interface HookWindow extends BridgeWindow {
  location: { origin: string; href: string };
  fetch: typeof fetch;
  XMLHttpRequest: { prototype: XMLHttpRequest };
  /** Page globals CodeChef's own client sends as headers. */
  csrfToken?: unknown;
  ccIdeSkipToken?: unknown;
}

type Kind = "submit" | "result" | null;

function classify(win: HookWindow, method: string, url: string): { kind: Kind; href: string } {
  try {
    const u = new URL(url, win.location.href);
    if (u.origin !== win.location.origin || u.pathname.replace(/\/$/, "") !== SUBMIT_PATH)
      return { kind: null, href: "" };
    const m = method.toUpperCase();
    if (m === "POST") return { kind: "submit", href: u.href };
    if (m === "GET" && u.searchParams.has("solution_id")) return { kind: "result", href: u.href };
  } catch {
    // ignore
  }
  return { kind: null, href: "" };
}

/** Reads the non-code fields of a submit body (FormData, URLSearchParams or urlencoded string). */
function submitFields(
  body: unknown,
): { problemCode: string; contestCode: string; languageId: string; preview: boolean } | null {
  let get: (k: string) => unknown;
  if (typeof FormData !== "undefined" && body instanceof FormData) get = (k) => body.get(k);
  else if (body instanceof URLSearchParams) get = (k) => body.get(k);
  else if (typeof body === "string") {
    const p = new URLSearchParams(body);
    get = (k) => p.get(k);
  } else return null;
  const str = (k: string) => {
    const v = get(k);
    return typeof v === "string" ? v : "";
  };
  return {
    problemCode: str("problemCode"),
    contestCode: str("contestCode"),
    languageId: str("language"),
    preview: str("assessmentPreviewMode") === "true",
  };
}

export function installCodeChefHook(win: HookWindow): void {
  const headers = () => ({
    ...(typeof win.csrfToken === "string" && win.csrfToken ? { csrfToken: win.csrfToken } : {}),
    ...(typeof win.ccIdeSkipToken === "string" && win.ccIdeSkipToken
      ? { ideKey: win.ccIdeSkipToken }
      : {}),
  });

  const relay = (kind: Kind, href: string, body: unknown, text: string) => {
    try {
      const response = JSON.parse(text) as unknown;
      if (kind === "result") {
        postToIsolated(win, CODECHEF_RESULT_CHANNEL, { url: href, body: response });
      } else if (kind === "submit") {
        const fields = submitFields(body);
        if (!fields || fields.preview) return; // assessments are not uploaded
        postToIsolated(win, CODECHEF_SUBMIT_CHANNEL, {
          problemCode: fields.problemCode,
          contestCode: fields.contestCode,
          languageId: fields.languageId,
          response,
          ...headers(),
        });
      }
    } catch {
      // not JSON / not ours
    }
  };

  const originalFetch = win.fetch;
  win.fetch = async function (this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
    const response = await originalFetch.apply(this, args);
    try {
      const [input, init] = args;
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method =
        init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
      const { kind, href } = classify(win, method, url);
      if (kind) {
        response
          .clone()
          .text()
          .then(
            (t) => relay(kind, href, init?.body, t),
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
  const originalSend = proto.send as (body?: unknown) => void;
  const pending = new WeakMap<XMLHttpRequest, { kind: Kind; href: string }>();
  proto.open = function (this: XMLHttpRequest, ...args: unknown[]) {
    try {
      const target = classify(win, String(args[0]), String(args[1]));
      if (target.kind) pending.set(this, target);
      else pending.delete(this);
    } catch {
      // ignore
    }
    return originalOpen.apply(this, args);
  } as typeof proto.open;
  proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    try {
      const target = pending.get(this);
      if (target) {
        this.addEventListener("load", () => {
          try {
            const text =
              this.responseType === "" || this.responseType === "text"
                ? this.responseText
                : this.responseType === "json"
                  ? JSON.stringify(this.response)
                  : "";
            if (text) relay(target.kind, target.href, body, text);
          } catch {
            // ignore
          }
        });
      }
    } catch {
      // ignore
    }
    return originalSend.call(this, body);
  };
}
