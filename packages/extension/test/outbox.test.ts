import { describe, expect, it, vi } from "vitest";
import {
  backoffDelay,
  MAX_DELAY_MS,
  MAX_OUTBOX_ITEMS,
  Outbox,
  type Deliver,
} from "../src/background/outbox.js";
import { makeEvent, MemoryStore } from "./helpers.js";

const NOW = 1_700_000_000_000;

describe("Outbox", () => {
  it("enqueues once per submission and reports duplicates", async () => {
    const outbox = new Outbox(new MemoryStore());
    const event = await makeEvent();
    expect(await outbox.enqueue(event, NOW)).toBe("enqueued");
    expect(await outbox.enqueue(event, NOW + 1)).toBe("duplicate");
    expect(await outbox.list()).toHaveLength(1);
  });

  it("collapses concurrent identical events into one item", async () => {
    const outbox = new Outbox(new MemoryStore());
    const event = await makeEvent();
    const results = await Promise.all(Array.from({ length: 20 }, () => outbox.enqueue(event, NOW)));
    expect(results.filter((r) => r === "enqueued")).toHaveLength(1);
    expect(await outbox.list()).toHaveLength(1);
  });

  it("survives a service worker restart (new instance, same storage)", async () => {
    const store = new MemoryStore();
    const event = await makeEvent();
    await new Outbox(store).enqueue(event, NOW);

    const restarted = new Outbox(store);
    const items = await restarted.list();
    expect(items).toHaveLength(1);
    expect(items[0]!.event.sourceCode).toBe(event.sourceCode); // byte-exact through storage
    expect(await restarted.enqueue(event, NOW)).toBe("duplicate"); // dedup state survives too
  });

  it("removes delivered items but remembers them as seen", async () => {
    const outbox = new Outbox(new MemoryStore());
    const event = await makeEvent();
    await outbox.enqueue(event, NOW);
    const deliver = vi.fn<Deliver>().mockResolvedValue({ kind: "accepted", status: "QUEUED" });
    const reports = await outbox.drain(deliver, () => NOW);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(reports[0]!.result).toEqual({ kind: "accepted", status: "QUEUED" });
    expect(await outbox.list()).toEqual([]);
    expect(await outbox.enqueue(event, NOW + 5)).toBe("duplicate");
  });

  it("keeps items on transient failure and backs off", async () => {
    const outbox = new Outbox(new MemoryStore(), () => 0);
    await outbox.enqueue(await makeEvent(), NOW);
    await outbox.drain(
      async () => ({ kind: "retry", error: "offline" }),
      () => NOW,
    );
    const [item] = await outbox.list();
    expect(item!.attempts).toBe(1);
    expect(item!.lastError).toBe("offline");
    expect(item!.nextAttemptAt).toBe(NOW + backoffDelay(1, () => 0));

    // Not due yet: nothing delivered.
    const deliver = vi.fn<Deliver>();
    await outbox.drain(deliver, () => NOW + 1);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("treats a throwing sink as a transient failure", async () => {
    const outbox = new Outbox(new MemoryStore());
    await outbox.enqueue(await makeEvent(), NOW);
    await outbox.drain(
      async () => {
        throw new Error("boom");
      },
      () => NOW,
    );
    expect((await outbox.list())[0]!.lastError).toBe("boom");
  });

  it("honors retryAfterMs when longer than the backoff", async () => {
    const outbox = new Outbox(new MemoryStore(), () => 0);
    await outbox.enqueue(await makeEvent(), NOW);
    await outbox.drain(
      async () => ({ kind: "retry", error: "rate limited", retryAfterMs: 600_000 }),
      () => NOW,
    );
    expect((await outbox.list())[0]!.nextAttemptAt).toBe(NOW + 600_000);
  });

  it("drops permanently rejected items", async () => {
    const outbox = new Outbox(new MemoryStore());
    await outbox.enqueue(await makeEvent(), NOW);
    const reports = await outbox.drain(
      async () => ({ kind: "rejected", error: "bad" }),
      () => NOW,
    );
    expect(reports[0]!.result.kind).toBe("rejected");
    expect(await outbox.list()).toEqual([]);
  });

  it("does not deliver the same item twice when drains overlap", async () => {
    const outbox = new Outbox(new MemoryStore());
    await outbox.enqueue(await makeEvent(), NOW);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const deliver = vi.fn<Deliver>(async () => {
      await gate;
      return { kind: "accepted", status: "QUEUED" };
    });
    const first = outbox.drain(deliver, () => NOW);
    const second = outbox.drain(deliver, () => NOW);
    release();
    await Promise.all([first, second]);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("delivers items enqueued while a drain is running", async () => {
    const outbox = new Outbox(new MemoryStore());
    await outbox.enqueue(await makeEvent({ submissionId: "1" }), NOW);
    const later = await makeEvent({ submissionId: "2" });
    const delivered: string[] = [];
    const deliver: Deliver = async (e) => {
      delivered.push(e.submissionId);
      if (e.submissionId === "1") {
        await outbox.enqueue(later, NOW);
        void outbox.drain(deliver, () => NOW); // overlapping request -> one more pass
      }
      return { kind: "accepted", status: "QUEUED" };
    };
    await outbox.drain(deliver, () => NOW);
    expect(delivered).toEqual(["1", "2"]);
  });

  it("ignores results for items cleared mid-delivery", async () => {
    const outbox = new Outbox(new MemoryStore());
    await outbox.enqueue(await makeEvent(), NOW);
    await outbox.drain(
      async () => {
        await outbox.clear();
        return { kind: "retry", error: "x" };
      },
      () => NOW,
    );
    expect(await outbox.list()).toEqual([]);
  });

  it("retryNow makes items due immediately", async () => {
    const outbox = new Outbox(new MemoryStore(), () => 0);
    await outbox.enqueue(await makeEvent(), NOW);
    await outbox.drain(
      async () => ({ kind: "retry", error: "x" }),
      () => NOW,
    );
    await outbox.retryNow(NOW + 1);
    expect(await outbox.nextAttemptAt()).toBe(NOW + 1);
  });

  it("refuses new items when full instead of evicting pending ones", async () => {
    const outbox = new Outbox(new MemoryStore());
    for (let i = 0; i < MAX_OUTBOX_ITEMS; i++) {
      expect(await outbox.enqueue(await makeEvent({ submissionId: String(i) }), NOW)).toBe(
        "enqueued",
      );
    }
    expect(await outbox.enqueue(await makeEvent({ submissionId: "overflow" }), NOW)).toBe("full");
    expect(await outbox.list()).toHaveLength(MAX_OUTBOX_ITEMS);
  });

  it("drops corrupt stored items but keeps valid ones", async () => {
    const store = new MemoryStore();
    const good = await makeEvent();
    await store.set("outbox:v1", {
      items: [
        { junk: true },
        { key: "leetcode:1001", event: good, attempts: 0, enqueuedAt: NOW, nextAttemptAt: NOW },
      ],
      seen: [],
    });
    expect(await new Outbox(store).list()).toHaveLength(1);
  });
});

describe("backoffDelay", () => {
  it("grows exponentially and is capped", () => {
    expect(backoffDelay(1, () => 1)).toBe(5_000);
    expect(backoffDelay(2, () => 1)).toBe(10_000);
    expect(backoffDelay(50, () => 1)).toBe(MAX_DELAY_MS);
    expect(backoffDelay(1, () => 0)).toBe(2_500);
  });
});
