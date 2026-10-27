// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLanguage, sha256Hex } from "@cst/shared";
import {
  buildEvent,
  csrfToken,
  currentHandle,
  decodeHtmlEntities,
  extractSourceFromSubmissionHtml,
  normalizeVerdict,
  parseProblemHref,
  parseStatusRows,
  parseSubmitSource,
  submissionIdFromHref,
} from "../src/adapters/codeforces/parse.js";

const raw = (name: string) =>
  readFileSync(resolve(import.meta.dirname, "fixtures/codeforces", name), "utf8");
const doc = (name: string) => new DOMParser().parseFromString(raw(name), "text/html");
const EXPECTED = raw("expected-source.txt");

describe("Codeforces verdict cells", () => {
  const cells = Array.from(doc("verdict-cells.html").querySelectorAll("td.status-verdict-cell"));
  it.each([
    [0, "testing", "PENDING"],
    [1, "in queue", "PENDING"],
    [2, "accepted", "ACCEPTED"],
    [3, "wrong answer", "REJECTED"],
    [4, "time limit", "REJECTED"],
    [5, "memory limit", "REJECTED"],
    [6, "runtime error", "REJECTED"],
    [7, "compilation error", "REJECTED"],
    [8, "skipped", "REJECTED"],
    [9, "hacked", "REJECTED"],
  ])("cell %i (%s) -> %s", (i, _label, verdict) => {
    expect(normalizeVerdict(cells[i])).toBe(verdict);
  });

  it("never treats a waiting cell or a lookalike as accepted", () => {
    const d = new DOMParser().parseFromString(
      `<table><tr>
        <td class="status-verdict-cell" waiting="true"><span submissionverdict="OK" class="verdict-accepted">Accepted</span></td>
        <td class="status-verdict-cell" waiting="false"><span submissionverdict="WRONG_ANSWER" class="verdict-accepted">Accepted</span></td>
        <td class="status-verdict-cell">Accepted</td>
      </tr></table>`,
      "text/html",
    );
    expect(Array.from(d.querySelectorAll("td")).map(normalizeVerdict)).toEqual([
      "PENDING",
      "REJECTED",
      "PENDING",
    ]);
    expect(normalizeVerdict(null)).toBe("PENDING");
    expect(normalizeVerdict("Accepted")).toBe("PENDING");
  });
});

describe("Codeforces URLs", () => {
  it.each([
    ["/contest/4/problem/A", { contestId: "4", index: "A", kind: "contest" }],
    ["/contest/1950/problem/c1", { contestId: "1950", index: "C1", kind: "contest" }],
    ["/problemset/problem/4/A", { contestId: "4", index: "A", kind: "problemset" }],
    ["/gym/100001/problem/A", { contestId: "100001", index: "A", kind: "gym" }],
    [
      "/group/AbCdEf1234/contest/345678/problem/C",
      { contestId: "345678", index: "C", kind: "gym", groupId: "AbCdEf1234" },
    ],
  ])("problem %s", (href, expected) => {
    expect(parseProblemHref(href)).toMatchObject(expected);
  });

  it("rejects other origins and non-problem paths", () => {
    expect(parseProblemHref("https://evil.example/contest/4/problem/A")).toBeNull();
    expect(parseProblemHref("/contest/4/standings")).toBeNull();
  });

  it.each([
    ["/contest/4/submission/300000003", "300000003"],
    ["/problemset/submission/4/300000020", "300000020"],
    ["/gym/100001/submission/300000030", "300000030"],
    ["/group/AbCdEf1234/contest/345678/submission/300000040", "300000040"],
    ["/contest/4/my", null],
  ])("submission %s", (href, id) => {
    expect(submissionIdFromHref(href)).toBe(id);
  });
});

describe("Codeforces status tables", () => {
  it("parses own rows on a contest 'my' page", () => {
    const d = doc("contest-my.html");
    expect(currentHandle(d)).toBe("alice");
    expect(csrfToken(d)).toBe("csrf-synthetic-0000");
    expect(parseStatusRows(d)).toEqual([
      {
        submissionId: "300000003",
        submissionUrl: "https://codeforces.com/contest/4/submission/300000003",
        authorHandle: "alice",
        contestId: "4",
        problemIndex: "A",
        problemName: "Watermelon",
        problemUrl: "https://codeforces.com/contest/4/problem/A",
        contestKind: "contest",
        language: "GNU G++20 13.2 (64 bit, winlibs)",
        verdict: "PENDING",
        rawVerdict: "Running on test 5",
      },
      expect.objectContaining({
        submissionId: "300000002",
        verdict: "REJECTED",
        rawVerdict: "Wrong answer on test 3",
        language: "Python 3",
      }),
      expect.objectContaining({
        submissionId: "200000001",
        verdict: "ACCEPTED",
        problemName: "Theatre Square",
      }),
    ]);
  });

  it.each([
    [
      "problemset-status.html",
      {
        contestId: "4",
        problemIndex: "A",
        contestKind: "problemset",
        problemName: "Watermelon",
        language: "Kotlin 1.9",
      },
    ],
    ["gym-my.html", { contestId: "100001", contestKind: "gym", language: "C# 10" }],
    [
      "group-my.html",
      {
        contestId: "345678",
        problemIndex: "C",
        contestKind: "gym",
        groupId: "AbCdEf1234",
        language: "Rust 2021",
      },
    ],
  ])("parses %s", (file, expected) => {
    expect(parseStatusRows(doc(file))[0]).toMatchObject(expected);
  });

  it("reports other users' rows with their handle and no handle when logged out", () => {
    expect(parseStatusRows(doc("contest-status-others.html")).map((r) => r.authorHandle)).toEqual([
      "bob",
      "carol",
    ]);
    expect(currentHandle(doc("logged-out.html"))).toBeNull();
  });

  it("skips rows it cannot fully understand", () => {
    const d = new DOMParser().parseFromString(
      `<table class="status-frame-datatable"><tr data-submission-id="1"><td>broken</td></tr>
       <tr data-submission-id="x"><td><a href="/contest/4/submission/x">x</a></td></tr></table>`,
      "text/html",
    );
    expect(parseStatusRows(d)).toEqual([]);
  });
});

describe("Codeforces source extraction", () => {
  it("reads exact source from submitSource JSON", () => {
    expect(parseSubmitSource(JSON.parse(raw("submit-source.json")))).toBe(EXPECTED);
    expect(() => parseSubmitSource({ error: "x" })).toThrow(/Unrecognized/);
  });

  it("reads exact source from the submission page text, keeping CRLF", () => {
    const source = extractSourceFromSubmissionHtml(raw("submission-page.html"));
    expect(source).toBe(EXPECTED);
    expect(source).toContain("\r\n\tint w; cin >> w;  \r\n");
    expect(source).toContain('"even" & > 2 → split é');
  });

  it("explains a missing or highlighted source block", () => {
    expect(() => extractSourceFromSubmissionHtml("<html></html>")).toThrow(/No source code/);
    expect(() =>
      extractSourceFromSubmissionHtml(
        '<pre id="program-source-text"><span class="kwd">int</span></pre>',
      ),
    ).toThrow(/not plain text/);
  });

  it("decodes named and numeric entities", () => {
    expect(
      decodeHtmlEntities("&lt;a&gt; &amp;&amp; &quot;x&quot; &#39;y&#39; &#x41;&#66; &unknown;"),
    ).toBe(`<a> && "x" 'y' AB &unknown;`);
  });
});

describe("Codeforces event", () => {
  it("builds an exact event with key, slug and contest", async () => {
    const [row] = parseStatusRows(doc("contest-my.html"));
    const event = await buildEvent({ ...row!, verdict: "ACCEPTED" }, EXPECTED, {
      submittedAt: 10,
      detectedAt: 20,
    });
    expect(event).toEqual({
      platform: "codeforces",
      problemKey: "4A",
      problemSlug: "4a-watermelon",
      problemId: "4A",
      problemTitle: "Watermelon",
      problemUrl: "https://codeforces.com/contest/4/problem/A",
      submissionId: "300000003",
      language: "GNU G++20 13.2 (64 bit, winlibs)",
      languageNormalized: "cpp",
      sourceCode: EXPECTED,
      sourceSha256: await sha256Hex(EXPECTED),
      verdict: "ACCEPTED",
      submittedAt: 10,
      detectedAt: 20,
      contest: { id: "4", kind: "contest" },
    });
  });

  it("records group contests with their group id", async () => {
    const [row] = parseStatusRows(doc("group-my.html"));
    const event = await buildEvent({ ...row!, verdict: "ACCEPTED" }, "fn main(){}", {
      submittedAt: 1,
      detectedAt: 1,
    });
    expect(event.contest).toEqual({ id: "AbCdEf1234/345678", kind: "gym" });
    expect(event.problemSlug).toBe("345678c-group-task");
  });

  it("refuses non-accepted rows and empty source", async () => {
    const [row] = parseStatusRows(doc("contest-my.html"));
    await expect(buildEvent(row!, EXPECTED, { submittedAt: 1, detectedAt: 1 })).rejects.toThrow(
      /not accepted/,
    );
    await expect(
      buildEvent({ ...row!, verdict: "ACCEPTED" }, "", { submittedAt: 1, detectedAt: 1 }),
    ).rejects.toThrow(/no source/);
  });

  it.each([
    ["GNU G++20 13.2 (64 bit, winlibs)", "cpp"],
    ["GNU G++17 7.3.0", "cpp"],
    ["Clang++20 Diagnostics", "cpp"],
    ["GNU GCC C11 5.1.0", "c"],
    ["Python 3", "py"],
    ["PyPy 3-64", "py"],
    ["Java 21", "java"],
    ["Kotlin 1.9", "kt"],
    ["C# 10", "cs"],
    ["Rust 2021", "rs"],
    ["Go", "go"],
    ["Node.js 15.8.0 (64bit)", "js"],
  ])("language %s -> .%s", (lang, ext) => {
    expect(resolveLanguage(lang).extension).toBe(ext);
  });
});
