import { describe, expect, it } from "vitest";
import { ingestSubmission, KeyValueJobStore, MAX_SKIPPED_JOBS } from "../src/index.js";
import { makeEvent, MemoryKV, newId, T0 } from "./helpers.js";

const opts = {
  userId: "u1",
  settings: { period: { kind: "permanent" as const }, timezone: "UTC" },
  now: T0,
  newId,
};

describe("KeyValueJobStore", () => {
  it("persists across instances (service worker restart) and enforces unique submissions", async () => {
    const kv = new MemoryKV();
    const a = new KeyValueJobStore(kv);
    const { job } = await ingestSubmission(a, await makeEvent(), opts);
    const b = new KeyValueJobStore(kv);
    expect(await b.get(job.id)).toEqual(job);
    await expect(b.insert({ ...job, id: "other" })).rejects.toThrow(/duplicate/);
  });

  it("lists runnable jobs and the next wake-up", async () => {
    const store = new KeyValueJobStore(new MemoryKV());
    const { job } = await ingestSubmission(store, await makeEvent(), opts);
    expect(await store.listRunnable(T0)).toHaveLength(1);
    await store.update({ ...job, status: "RETRYING", nextAttemptAt: T0 + 5000 });
    expect(await store.listRunnable(T0)).toHaveLength(0);
    expect(await store.nextWakeAt()).toBe(T0 + 5000);
  });

  it("prunes old skipped records but keeps every SUCCESS (needed for dedup)", async () => {
    const store = new KeyValueJobStore(new MemoryKV());
    const first = await ingestSubmission(store, await makeEvent(), opts);
    await store.update({ ...first.job, status: "SUCCESS" });
    for (let i = 0; i < MAX_SKIPPED_JOBS + 10; i++) {
      await ingestSubmission(store, await makeEvent({ submissionId: `s${i}` }), {
        ...opts,
        now: T0 + i,
      });
    }
    const all = await store.list();
    expect(all.filter((j) => j.status === "SKIPPED_NOT_ELIGIBLE")).toHaveLength(MAX_SKIPPED_JOBS);
    expect(all.some((j) => j.status === "SUCCESS")).toBe(true);
  }, 30_000);
});
