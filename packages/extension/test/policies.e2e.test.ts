import { describe, expect, it } from "vitest";
import type { PopupState } from "../src/background/handler.js";
import { makeEvent } from "./helpers.js";
import { createPipeline } from "./pipeline.js";

// Auto-upload off, manual upload and force upload through the real
// service-worker pipeline (handler -> outbox -> local uploader -> fake GitHub).

const LC_TAB = "https://leetcode.com/problems/two-sum/";

async function state(p: Awaited<ReturnType<typeof createPipeline>>): Promise<PopupState> {
  const reply = await p.page({ type: "state/get" });
  if (!reply.ok) throw new Error(reply.error);
  return reply.data as PopupState;
}

describe("upload policies end to end", () => {
  it("holds with auto-upload off, then uploads when the user clicks Upload now", async () => {
    const p = await createPipeline();
    await p.settings.set({ ...(await p.settings.get()), autoUpload: false });
    const event = await makeEvent();
    await p.sender(LC_TAB)({ type: "submission/detected", event });
    await p.settle();
    expect((await state(p)).uploads).toEqual([
      expect.objectContaining({ status: "HELD", sourceStored: true }),
    ]);
    expect(p.gh.log()).toHaveLength(1); // only the fake repo's initial commit

    expect(
      await p.page({ type: "upload/retry", platform: "leetcode", submissionId: "1001" }),
    ).toEqual({ ok: true, data: "QUEUED" });
    await p.settle();
    const after = await state(p);
    expect(after.uploads[0]).toMatchObject({ status: "SUCCESS", sourceStored: false });
    expect(after.uploadedCount).toBe(1);
    expect(p.gh.readFile("data/leetcode/two-sum/solution.py")).toBe(event.sourceCode);
  });

  it("skips a second solution in the period, then force-uploads it beside the first", async () => {
    const p = await createPipeline();
    await p.sender(LC_TAB)({ type: "submission/detected", event: await makeEvent() });
    await p.settle();
    p.advance(60_000);
    const second = await makeEvent({ submissionId: "1002", sourceCode: "print('second')\n" });
    await p.sender(LC_TAB)({ type: "submission/detected", event: second });
    await p.settle();
    expect((await state(p)).uploads.map((u) => u.status)).toEqual([
      "SKIPPED_NOT_ELIGIBLE",
      "SUCCESS",
    ]);

    await p.page({ type: "upload/force", platform: "leetcode", submissionId: "1002" });
    await p.settle();
    const after = await state(p);
    expect(after.uploads[0]).toMatchObject({ status: "SUCCESS", force: true });
    expect(after.uploadedCount).toBe(2);
    expect(p.gh.readFile("data/leetcode/two-sum/solution-1002.py")).toBe(second.sourceCode);
    expect(p.gh.log()[0]).toBe("feat(solutions): add LeetCode - Two Sum (Python)");

    // Forcing again is a no-op: the submission is already uploaded.
    await p.page({ type: "upload/force", platform: "leetcode", submissionId: "1002" });
    await p.settle();
    expect(p.gh.log()).toHaveLength(3);
  });
});
