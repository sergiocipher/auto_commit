import { beforeEach, describe, expect, it } from "vitest";
import { buildCommitMessage, resolveLanguage, sha256Hex } from "@cst/shared";
import { GitHubClient, UploadError, uploadSolution, type UploadInput } from "../src/index.js";
import { FakeGitHub } from "./fakeGitHub.js";
import { fakeToken, makeEvent, T0, TOKEN } from "./helpers.js";

let gh: FakeGitHub;
let client: GitHubClient;
const repo = { owner: "octo", name: "solutions", branch: "main" };

async function input(
  overrides: Parameters<typeof makeEvent>[0] = {},
  uploadMetadata = true,
): Promise<UploadInput> {
  const event = await makeEvent(overrides);
  const language = resolveLanguage(event.language);
  return {
    repo,
    event,
    language,
    uploadMetadata,
    now: T0 + 5000,
    commitMessage: buildCommitMessage({
      platform: event.platform,
      problemTitle: event.problemTitle,
      problemKey: event.problemKey,
      languageDisplay: language.display,
    }),
  };
}

beforeEach(() => {
  gh = new FakeGitHub();
  client = new GitHubClient(gh.fetch, TOKEN, () => T0);
});

describe("uploadSolution", () => {
  it("writes solution and metadata in one commit with the exact message", async () => {
    const inp = await input();
    const out = await uploadSolution(client, inp);
    expect(out).toMatchObject({
      kind: "committed",
      filePath: "data/leetcode/two-sum/solution.cpp",
    });
    expect(gh.log()).toEqual(["feat(solutions): add LeetCode - Two Sum (C++)", "Initial commit"]);
    expect(gh.files()).toEqual([
      "data/leetcode/two-sum/metadata.json",
      "data/leetcode/two-sum/solution.cpp",
    ]);
    // byte-exact: CRLF, tabs, trailing spaces, unicode
    const stored = gh.readFile("data/leetcode/two-sum/solution.cpp")!;
    expect(stored).toBe(inp.event.sourceCode);
    expect(await sha256Hex(stored)).toBe(inp.event.sourceSha256);
    expect(gh.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
    expect(gh.requests.find((r) => r.method === "PATCH")!.body).toMatchObject({ force: false });
  });

  it("writes metadata without credentials, keyed by language and submission", async () => {
    await uploadSolution(client, await input());
    const meta = JSON.parse(gh.readFile("data/leetcode/two-sum/metadata.json")!);
    expect(meta).toMatchObject({
      schemaVersion: 1,
      platform: "leetcode",
      problemKey: "two-sum",
      problemTitle: "Two Sum",
      solutions: {
        "cpp:1001": {
          file: "solution.cpp",
          submissionId: "1001",
          language: "cpp",
          languageNormalized: "cpp",
        },
      },
    });
    expect(JSON.stringify(meta)).not.toMatch(/gho_|token|Bearer/i);
  });

  it("makes no commit when identical content is already there", async () => {
    await uploadSolution(client, await input());
    const before = gh.head();
    const out = await uploadSolution(client, await input({ submissionId: "2002" }));
    expect(out).toEqual({
      kind: "identical",
      filePath: "data/leetcode/two-sum/solution.cpp",
      commitSha: before,
    });
    expect(gh.head()).toBe(before);
  });

  it("never overwrites a different solution; uses the submission-id path", async () => {
    await uploadSolution(client, await input());
    const original = gh.readFile("data/leetcode/two-sum/solution.cpp");
    const out = await uploadSolution(
      client,
      await input({ submissionId: "2002", sourceCode: "int main(){}\n" }),
    );
    expect(out).toMatchObject({
      kind: "committed",
      filePath: "data/leetcode/two-sum/solution-2002.cpp",
    });
    expect(gh.readFile("data/leetcode/two-sum/solution.cpp")).toBe(original);
    expect(gh.readFile("data/leetcode/two-sum/solution-2002.cpp")).toBe("int main(){}\n");
    const meta = JSON.parse(gh.readFile("data/leetcode/two-sum/metadata.json")!);
    expect(Object.keys(meta.solutions)).toEqual(["cpp:1001", "cpp:2002"]);
  });

  it("refuses when even the submission-id path holds different content", async () => {
    await gh.pushExternal("data/leetcode/two-sum/solution.cpp", "a");
    await gh.pushExternal("data/leetcode/two-sum/solution-1001.cpp", "b");
    const head = gh.head();
    await expect(uploadSolution(client, await input())).rejects.toMatchObject({
      kind: "permanent",
    });
    expect(gh.head()).toBe(head);
  });

  it("keeps different languages in separate files", async () => {
    await uploadSolution(client, await input());
    await uploadSolution(
      client,
      await input({ submissionId: "3003", language: "python3", sourceCode: "print(1)\n" }),
    );
    expect(gh.files()).toContain("data/leetcode/two-sum/solution.py");
    expect(gh.readFile("data/leetcode/two-sum/solution.cpp")).toBeDefined();
  });

  it("preserves user fields in metadata.json and leaves invalid files untouched", async () => {
    await gh.pushExternal(
      "data/leetcode/two-sum/metadata.json",
      JSON.stringify({
        schemaVersion: 1,
        platform: "leetcode",
        problemKey: "two-sum",
        problemTitle: "Two Sum",
        problemUrl: "u",
        notes: "mine",
        solutions: {},
      }),
    );
    await uploadSolution(client, await input());
    expect(JSON.parse(gh.readFile("data/leetcode/two-sum/metadata.json")!).notes).toBe("mine");

    const gh2 = new FakeGitHub();
    await gh2.pushExternal("data/leetcode/two-sum/metadata.json", "{not json");
    const out = await uploadSolution(new GitHubClient(gh2.fetch, TOKEN, () => T0), await input());
    expect(out).toMatchObject({ kind: "committed", warning: expect.stringMatching(/not valid/) });
    expect(gh2.readFile("data/leetcode/two-sum/metadata.json")).toBe("{not json");
  });

  it("refuses a folder whose metadata belongs to another problem", async () => {
    await gh.pushExternal(
      "data/leetcode/two-sum/metadata.json",
      JSON.stringify({
        schemaVersion: 1,
        platform: "leetcode",
        problemKey: "other",
        problemTitle: "x",
        problemUrl: "u",
        solutions: {},
      }),
    );
    await expect(uploadSolution(client, await input())).rejects.toMatchObject({
      kind: "permanent",
    });
  });

  it("decodes unicode metadata written earlier (base64 round trip)", async () => {
    await uploadSolution(client, await input({ problemTitle: "Ünïcode ✓ Title" }));
    await uploadSolution(
      client,
      await input({
        submissionId: "9",
        language: "java",
        sourceCode: "class A{}",
        problemTitle: "Ünïcode ✓ Title",
      }),
    );
    const meta = JSON.parse(gh.readFile("data/leetcode/two-sum/metadata.json")!);
    expect(meta.problemTitle).toBe("Ünïcode ✓ Title");
    expect(Object.keys(meta.solutions)).toHaveLength(2);
  });

  it("skips metadata when disabled", async () => {
    await uploadSolution(client, await input({}, false));
    expect(gh.files()).toEqual(["data/leetcode/two-sum/solution.cpp"]);
  });

  it("rebuilds on a ref conflict without losing the other change", async () => {
    let pushed = false;
    gh.beforeRefUpdate = async () => {
      if (!pushed) {
        pushed = true;
        await gh.pushExternal("README.md", "hello", "someone else");
      }
    };
    const out = await uploadSolution(client, await input());
    expect(out.kind).toBe("committed");
    expect(gh.log()).toEqual([
      "feat(solutions): add LeetCode - Two Sum (C++)",
      "someone else",
      "Initial commit",
    ]);
    expect(gh.readFile("README.md")).toBe("hello");
  });

  it("gives up after bounded ref conflicts", async () => {
    let n = 0;
    gh.beforeRefUpdate = async () => {
      await gh.pushExternal(`f${n++}.txt`, "x");
    };
    const err = await uploadSolution(client, await input()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).kind).toBe("conflict");
    expect(n).toBe(4);
  });

  it("classifies missing branch, empty repo, bad token and server errors", async () => {
    const missing = new GitHubClient(gh.fetch, TOKEN, () => T0);
    await expect(
      uploadSolution(missing, { ...(await input()), repo: { ...repo, branch: "nope" } }),
    ).rejects.toMatchObject({ kind: "permanent", status: 404 });

    const empty = new FakeGitHub({ empty: true });
    await expect(
      uploadSolution(new GitHubClient(empty.fetch, TOKEN, () => T0), await input()),
    ).rejects.toMatchObject({ kind: "permanent", status: 409 });

    await expect(
      uploadSolution(
        new GitHubClient(gh.fetch, fakeToken("gho", "wrong"), () => T0),
        await input(),
      ),
    ).rejects.toMatchObject({ kind: "needs_auth" });

    gh.failNext({ method: "POST", pathIncludes: "/git/blobs" }, 502);
    await expect(uploadSolution(client, await input())).rejects.toMatchObject({
      kind: "retryable",
    });
    expect(gh.log()).toEqual(["Initial commit"]);
  });

  it("refuses when the problem folder path is a file", async () => {
    await gh.pushExternal("data/leetcode/two-sum", "oops");
    await expect(uploadSolution(client, await input())).rejects.toMatchObject({
      kind: "permanent",
    });
  });

  it("sends the token only in the Authorization header", async () => {
    await uploadSolution(client, await input());
    for (const r of gh.requests) {
      expect(r.auth).toBe(`Bearer ${TOKEN}`);
      expect(r.path).not.toContain(TOKEN);
      expect(JSON.stringify(r.body ?? "")).not.toContain(TOKEN);
    }
  });
});
