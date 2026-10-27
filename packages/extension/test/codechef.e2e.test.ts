import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createCodeChefAdapter } from "../src/adapters/codechef/adapter.js";
import {
  CODECHEF_RESULT_CHANNEL,
  CODECHEF_SUBMIT_CHANNEL,
} from "../src/adapters/codechef/channel.js";
import { postToIsolated } from "../src/content/bridge.js";
import { runAdapter } from "../src/content/runner.js";
import { deriveStatus } from "../src/ui/status.js";
import { fakeWindow, flush } from "./fakeWindow.js";
import { fixture } from "./fixtures.js";
import { createPipeline } from "./pipeline.js";

const cc = (name: string) => fixture("codechef", name);
const EXPECTED = readFileSync(
  resolve(import.meta.dirname, "fixtures/codechef/expected-source.txt"),
  "utf8",
);

async function setup() {
  const p = await createPipeline();
  const win = fakeWindow("https://www.codechef.com/problems/FLOW001");
  const adapter = createCodeChefAdapter({
    win,
    fetch: async (url) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.includes("submission-code")
          ? cc("submission-code.json")
          : url.includes("/languages/")
            ? cc("languages.json")
            : cc("problem.json"),
    }),
    now: p.now,
  });
  runAdapter(adapter, win.location.href, p.sender(win.location.href), new AbortController().signal);
  const play = async (resultFile: string) => {
    postToIsolated(win, CODECHEF_SUBMIT_CHANNEL, {
      problemCode: "FLOW001",
      contestCode: "PRACTICE",
      languageId: "63",
      response: cc("submit-response.json"),
    });
    postToIsolated(win, CODECHEF_RESULT_CHANNEL, {
      url: "https://www.codechef.com/api/ide/submit?solution_id=1100223344",
      body: cc(resultFile),
    });
    await flush(20);
    await p.settle();
  };
  return { ...p, play };
}

describe("CodeChef -> GitHub (mocked GitHub, synthetic CodeChef payloads)", () => {
  it("uploads an accepted submission byte-exactly with the right commit and folder", async () => {
    const t = await setup();
    await t.play("result-accepted.json");
    expect(t.gh.readFile("data/codechef/flow001-add-two-numbers/solution.cpp")).toBe(EXPECTED);
    expect(t.gh.log()).toEqual([
      "feat(solutions): add CodeChef - FLOW001 Add Two Numbers (C++)",
      "Initial commit",
    ]);
    expect(
      JSON.parse(t.gh.readFile("data/codechef/flow001-add-two-numbers/metadata.json")!),
    ).toMatchObject({
      platform: "codechef",
      problemKey: "FLOW001",
      contest: { id: "PRACTICE", kind: "practice" },
    });
    expect(deriveStatus((await t.activity.list())[0])).toBe("success");
  });

  it("does not upload a partially accepted submission", async () => {
    const t = await setup();
    await t.play("result-partial_accepted.json");
    expect(t.gh.log()).toEqual(["Initial commit"]);
  });
});
