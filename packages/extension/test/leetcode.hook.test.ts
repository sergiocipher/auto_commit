import { describe, expect, it, vi } from "vitest";
import { installCheckHook, type HookWindow } from "../src/adapters/leetcode/hook.js";
import { BRIDGE_TAG } from "../src/content/bridge.js";

class FakeXHR extends EventTarget {
  responseType = "";
  responseText = "";
  response: unknown = null;
  open(_method: string, _url: string) {}
}

function setup(fetchImpl: typeof fetch) {
  const posted: unknown[] = [];
  const win = {
    location: { origin: "https://leetcode.com", href: "https://leetcode.com/problems/two-sum/" },
    postMessage: (m: unknown, origin: string) => {
      expect(origin).toBe("https://leetcode.com");
      posted.push(m);
    },
    addEventListener: () => undefined,
    fetch: fetchImpl,
    XMLHttpRequest: FakeXHR as unknown as HookWindow["XMLHttpRequest"],
  } satisfies HookWindow;
  installCheckHook(win);
  return { win, posted };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("LeetCode page hook", () => {
  it("relays check responses from fetch and returns the original response untouched", async () => {
    const original = new Response('{"state":"SUCCESS","status_code":10}', { status: 200 });
    const { win, posted } = setup(vi.fn(async () => original));
    const res = await win.fetch("/submissions/detail/42/check/");
    expect(res).toBe(original);
    expect(await res.text()).toBe('{"state":"SUCCESS","status_code":10}'); // body still readable by the page
    await flush();
    expect(posted).toEqual([
      {
        tag: BRIDGE_TAG,
        channel: "leetcode-check",
        payload: {
          url: "/submissions/detail/42/check/",
          body: { state: "SUCCESS", status_code: 10 },
        },
      },
    ]);
  });

  it("ignores unrelated requests and other origins", async () => {
    const { win, posted } = setup(vi.fn(async () => new Response("{}")));
    await win.fetch("/graphql/");
    await win.fetch("https://evil.example/submissions/detail/42/check/");
    await flush();
    expect(posted).toEqual([]);
  });

  it("never breaks the page on non-JSON bodies or fetch errors", async () => {
    const { win, posted } = setup(vi.fn(async () => new Response("<html>")));
    await expect(win.fetch("/submissions/detail/42/check/")).resolves.toBeInstanceOf(Response);
    await flush();
    expect(posted).toEqual([]);
    const failing = setup(
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    await expect(failing.win.fetch("/submissions/detail/42/check/")).rejects.toThrow("offline");
  });

  it("relays XHR check responses", () => {
    const { posted } = setup(vi.fn());
    const xhr = new FakeXHR(); // setup() patched FakeXHR.prototype.open
    xhr.open("GET", "/submissions/detail/7/check/");
    xhr.responseText = '{"state":"PENDING"}';
    xhr.dispatchEvent(new Event("load"));
    expect(posted).toHaveLength(1);
  });
});
