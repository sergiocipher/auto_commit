// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createCodeforcesAdapter } from "../src/adapters/codeforces/adapter.js";
import { runAdapter } from "../src/content/runner.js";
import { deriveStatus } from "../src/ui/status.js";
import { createPipeline } from "./pipeline.js";

const raw = (name: string) =>
  readFileSync(resolve(import.meta.dirname, "fixtures/codeforces", name), "utf8");
const EXPECTED = raw("expected-source.txt");
const cellsDoc = new DOMParser().parseFromString(raw("verdict-cells.html"), "text/html");
const cell = (i: number) => cellsDoc.querySelectorAll("td.status-verdict-cell")[i]!.cloneNode(true);

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

async function setup() {
  const p = await createPipeline();
  const doc = new DOMParser().parseFromString(raw("contest-my.html"), "text/html");
  let trigger = () => {};
  const adapter = createCodeforcesAdapter({
    doc,
    fetch: async (url) => ({
      ok: true,
      status: 200,
      text: async () =>
        url.endsWith("/data/submitSource")
          ? raw("submit-source.json")
          : raw("submission-page.html"),
    }),
    now: p.now,
    referrer: "",
    observe: (onChange) => {
      trigger = onChange;
    },
  });
  runAdapter(
    adapter,
    "https://codeforces.com/contest/4/my",
    p.sender("https://codeforces.com/contest/4/my"),
    new AbortController().signal,
  );
  const judge = async (submissionId: string, cellIndex: number) => {
    doc
      .querySelector(`tr[data-submission-id="${submissionId}"] td.status-verdict-cell`)!
      .replaceWith(cell(cellIndex));
    trigger();
    await flush();
    await p.settle();
  };
  return { ...p, judge };
}

describe("Codeforces -> GitHub (mocked GitHub, synthetic Codeforces pages)", () => {
  it("uploads an accepted submission byte-exactly with the right commit and folder", async () => {
    const t = await setup();
    await t.judge("300000003", 2);
    expect(t.gh.readFile("data/codeforces/4a-watermelon/solution.cpp")).toBe(EXPECTED);
    expect(t.gh.log()).toEqual([
      "feat(solutions): add Codeforces - 4A Watermelon (C++)",
      "Initial commit",
    ]);
    const meta = JSON.parse(t.gh.readFile("data/codeforces/4a-watermelon/metadata.json")!);
    expect(meta).toMatchObject({
      platform: "codeforces",
      problemKey: "4A",
      contest: { id: "4", kind: "contest" },
    });
    expect(deriveStatus((await t.activity.list())[0])).toBe("success");
  });

  it("does not upload a wrong answer or the accepted rows already in history", async () => {
    const t = await setup();
    await t.judge("300000003", 3);
    expect(t.gh.log()).toEqual(["Initial commit"]);
  });
});
