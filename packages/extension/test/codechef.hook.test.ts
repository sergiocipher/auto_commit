import { describe, expect, it, vi } from "vitest";
import { installCodeChefHook, type HookWindow } from "../src/adapters/codechef/hook.js";
import { BRIDGE_TAG } from "../src/content/bridge.js";

class FakeXHR extends EventTarget {
  responseType = "";
  responseText = "";
  response: unknown = null;
  open(_method: string, _url: string) {}
  send(_body?: unknown) {}
}

function setup(
  globals: { csrfToken?: unknown; ccIdeSkipToken?: unknown } = { csrfToken: "csrf-synthetic" },
) {
  const posted: { tag: string; channel: string; payload: Record<string, unknown> }[] = [];
  const win: HookWindow = {
    location: {
      origin: "https://www.codechef.com",
      href: "https://www.codechef.com/problems/FLOW001",
    },
    postMessage: (m, origin) => {
      expect(origin).toBe("https://www.codechef.com");
      posted.push(m as (typeof posted)[number]);
    },
    addEventListener: () => undefined,
    fetch: vi.fn(async () => new Response('{"upid":"7","result_code":"accepted"}')),
    XMLHttpRequest: FakeXHR as unknown as HookWindow["XMLHttpRequest"],
    ...globals,
  };
  installCodeChefHook(win);
  const xhr = (method: string, url: string, body: unknown, responseText: string) => {
    const x = new FakeXHR();
    x.open(method, url);
    x.send(body);
    x.responseText = responseText;
    x.dispatchEvent(new Event("load"));
  };
  return { win, posted, xhr };
}

/** CodeChef's axios client sends absolute URLs (baseURL = origin). */
const API = "https://www.codechef.com/api/ide/";

const submitForm = (extra: Record<string, string> = {}) => {
  const f = new FormData();
  f.append("sourceCode", "SECRET_SOURCE_MARKER");
  f.append("language", "63");
  f.append("problemCode", "FLOW001");
  f.append("contestCode", "PRACTICE");
  for (const [k, v] of Object.entries(extra)) f.append(k, v);
  return f;
};

describe("CodeChef page hook", () => {
  it("relays submit metadata and headers, never the source code", () => {
    const t = setup({ csrfToken: "csrf-synthetic", ccIdeSkipToken: "ide-synthetic" });
    t.xhr("POST", API + "submit", submitForm(), '{"status":"OK","upid":"7"}');
    expect(t.posted).toEqual([
      {
        tag: BRIDGE_TAG,
        channel: "codechef-submit",
        payload: {
          problemCode: "FLOW001",
          contestCode: "PRACTICE",
          languageId: "63",
          response: { status: "OK", upid: "7" },
          csrfToken: "csrf-synthetic",
          ideKey: "ide-synthetic",
        },
      },
    ]);
    expect(JSON.stringify(t.posted)).not.toContain("SECRET_SOURCE_MARKER");
  });

  it("reads urlencoded string bodies too", () => {
    const t = setup();
    t.xhr(
      "POST",
      "https://www.codechef.com/api/ide/submit",
      "sourceCode=x&language=116&problemCode=ABC&contestCode=START1",
      '{"upid":"8"}',
    );
    expect(t.posted[0]!.payload).toMatchObject({
      problemCode: "ABC",
      contestCode: "START1",
      languageId: "116",
    });
  });

  it("skips assessment preview submissions", () => {
    const t = setup();
    t.xhr("POST", API + "submit", submitForm({ assessmentPreviewMode: "true" }), '{"upid":"9"}');
    expect(t.posted).toEqual([]);
  });

  it("relays verdict polling responses", () => {
    const t = setup();
    t.xhr("GET", API + "submit?solution_id=7", null, '{"upid":"7","result_code":"wait"}');
    expect(t.posted[0]).toEqual({
      tag: BRIDGE_TAG,
      channel: "codechef-result",
      payload: {
        url: "https://www.codechef.com/api/ide/submit?solution_id=7",
        body: { upid: "7", result_code: "wait" },
      },
    });
  });

  it("relays fetch-based polling and leaves the response readable", async () => {
    const t = setup();
    const res = await t.win.fetch("/api/ide/submit?solution_id=7");
    expect(await res.text()).toBe('{"upid":"7","result_code":"accepted"}');
    await new Promise((r) => setTimeout(r, 0));
    expect(t.posted[0]!.channel).toBe("codechef-result");
  });

  it("ignores runs, other endpoints, other origins and non-JSON", () => {
    const t = setup();
    t.xhr("POST", API + "run/FLOW001", submitForm(), '{"timestamp":1}');
    t.xhr("GET", API + "submit", null, '{"x":1}');
    t.xhr(
      "GET",
      "https://evil.example/api/ide/submit?solution_id=7",
      null,
      '{"result_code":"accepted"}',
    );
    t.xhr("GET", API + "submit?solution_id=7", null, "<html>");
    expect(t.posted).toEqual([]);
  });

  it("omits header values that are not set", () => {
    const t = setup({});
    t.xhr("POST", API + "submit", submitForm(), '{"upid":"7"}');
    expect(t.posted[0]!.payload).not.toHaveProperty("csrfToken");
    expect(t.posted[0]!.payload).not.toHaveProperty("ideKey");
  });
});
