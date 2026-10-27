import { describe, expect, it } from "vitest";
import { ActivityLog, MAX_ACTIVITY_ENTRIES } from "../src/background/activity.js";
import { makeEvent, MemoryStore } from "./helpers.js";

describe("ActivityLog", () => {
  it("keeps newest first and moves updated entries to the top", async () => {
    const log = new ActivityLog(new MemoryStore());
    await log.recordQueued(await makeEvent({ submissionId: "1" }), 1);
    await log.recordQueued(await makeEvent({ submissionId: "2" }), 2);
    await log.recordDelivery(
      {
        key: "leetcode:1",
        event: await makeEvent({ submissionId: "1" }),
        result: { kind: "accepted", status: "SUCCESS" },
      },
      3,
    );
    const list = await log.list();
    expect(list.map((e) => e.submissionId)).toEqual(["1", "2"]);
    expect(list[0]).toMatchObject({ status: "SUCCESS", queued: false });
  });

  it("maps delivery outcomes", async () => {
    const log = new ActivityLog(new MemoryStore());
    const event = await makeEvent();
    await log.recordDelivery(
      { key: "leetcode:1001", event, result: { kind: "retry", error: "offline" } },
      1,
    );
    expect((await log.list())[0]).toMatchObject({ queued: true, detail: "offline" });
    await log.recordDelivery(
      { key: "leetcode:1001", event, result: { kind: "rejected", error: "bad" } },
      2,
    );
    expect((await log.list())[0]).toMatchObject({
      status: "FAILED_PERMANENT",
      detail: "bad",
      queued: false,
    });
  });

  it("is bounded", async () => {
    const log = new ActivityLog(new MemoryStore());
    for (let i = 0; i < MAX_ACTIVITY_ENTRIES + 5; i++) {
      await log.recordVerdict(
        {
          type: "verdict/observed",
          platform: "leetcode",
          submissionId: String(i),
          verdict: "REJECTED",
          at: i,
        },
        i,
      );
    }
    expect(await log.list()).toHaveLength(MAX_ACTIVITY_ENTRIES);
  });
});
