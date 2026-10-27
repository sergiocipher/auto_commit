import { describe, expect, it, vi } from "vitest";
import type { CodingPlatformAdapter, AdapterContext } from "../src/adapters/types.js";
import { runAdapter } from "../src/content/runner.js";
import { makeEvent } from "./helpers.js";

function fakeAdapter(): CodingPlatformAdapter & { ctx?: AdapterContext } {
  const adapter: CodingPlatformAdapter & { ctx?: AdapterContext } = {
    platform: "leetcode",
    canHandle: (url) => url.startsWith("https://leetcode.com/"),
    start: (ctx) => {
      adapter.ctx = ctx;
    },
    normalizeVerdict: () => "PENDING",
  };
  return adapter;
}

describe("runAdapter", () => {
  it("does nothing on pages the adapter cannot handle", () => {
    const adapter = fakeAdapter();
    expect(runAdapter(adapter, "https://example.com/", vi.fn(), new AbortController().signal)).toBe(
      false,
    );
    expect(adapter.ctx).toBeUndefined();
  });

  it("forwards each submission once despite re-emits", async () => {
    const adapter = fakeAdapter();
    const send = vi.fn().mockResolvedValue({ ok: true });
    runAdapter(
      adapter,
      "https://leetcode.com/problems/two-sum/",
      send,
      new AbortController().signal,
    );
    const event = await makeEvent();
    adapter.ctx!.emitSubmission(event);
    adapter.ctx!.emitSubmission(event);
    adapter.ctx!.emitSubmission({ ...event });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: "submission/detected", event });
  });

  it("never forwards non-accepted submissions", async () => {
    const adapter = fakeAdapter();
    const send = vi.fn().mockResolvedValue({ ok: true });
    runAdapter(adapter, "https://leetcode.com/", send, new AbortController().signal);
    adapter.ctx!.emitSubmission(await makeEvent({ verdict: "REJECTED" }));
    adapter.ctx!.emitSubmission(await makeEvent({ verdict: "PENDING" }));
    expect(send).not.toHaveBeenCalled();
  });

  it("forwards each distinct verdict once (pending then accepted)", () => {
    const adapter = fakeAdapter();
    const send = vi.fn().mockResolvedValue({ ok: true });
    runAdapter(adapter, "https://leetcode.com/", send, new AbortController().signal);
    const v = { platform: "leetcode" as const, submissionId: "1", at: 5 };
    adapter.ctx!.emitVerdict({ ...v, verdict: "PENDING" });
    adapter.ctx!.emitVerdict({ ...v, verdict: "PENDING" });
    adapter.ctx!.emitVerdict({ ...v, verdict: "ACCEPTED" });
    expect(send.mock.calls.map((c) => c[0].verdict)).toEqual(["PENDING", "ACCEPTED"]);
  });

  it("stops forwarding after abort and swallows send failures", async () => {
    const adapter = fakeAdapter();
    const send = vi.fn().mockRejectedValue(new Error("Extension context invalidated."));
    const ac = new AbortController();
    runAdapter(adapter, "https://leetcode.com/", send, ac.signal);
    adapter.ctx!.emitSubmission(await makeEvent({ submissionId: "1" }));
    ac.abort();
    adapter.ctx!.emitSubmission(await makeEvent({ submissionId: "2" }));
    expect(send).toHaveBeenCalledTimes(1);
    await Promise.resolve(); // rejection handled, no unhandled-rejection failure
  });
});
