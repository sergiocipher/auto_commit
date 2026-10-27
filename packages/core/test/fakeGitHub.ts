import { utf8Bytes } from "@cst/shared";
import { decodeBase64Utf8, gitBlobSha } from "../src/encoding.js";
import type { HttpFetch, HttpRequestInit, HttpResponse } from "../src/runtime.js";

/**
 * In-memory GitHub REST fake covering the endpoints the uploader and the
 * extension use. Real git blob SHAs are computed so identical-content
 * detection behaves like GitHub; trees are flat path->blob maps.
 */

interface Commit {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
}

interface Fault {
  method?: string;
  pathIncludes?: string;
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  remaining: number;
}

/** Token the fake accepts by default. Built at runtime: no token-shaped literal in source. */
export const FAKE_TOKEN = ["gho", "fake".padEnd(36, "0")].join("_");

const g = globalThis as unknown as { btoa(s: string): string };

function base64(text: string): string {
  const bytes = utf8Bytes(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  // GitHub wraps base64 at 60 chars; mimic that so decoders must cope.
  return (g.btoa(bin).match(/.{1,60}/g) ?? []).join("\n");
}

function response(
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
): HttpResponse {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  };
}

export interface FakeGitHubOptions {
  owner?: string;
  repo?: string;
  branch?: string;
  token?: string;
  login?: string;
  /** Start with an empty repository (no commits). */
  empty?: boolean;
}

export class FakeGitHub {
  readonly owner: string;
  readonly repo: string;
  readonly login: string;
  validTokens: Set<string>;
  readonly blobs = new Map<string, string>();
  readonly trees = new Map<string, Map<string, string>>();
  readonly commits = new Map<string, Commit>();
  readonly refs = new Map<string, string>();
  readonly requests: { method: string; path: string; body?: unknown; auth?: string }[] = [];
  private faults: Fault[] = [];
  private counter = 0;
  /** Called right before a ref update is applied (simulate concurrent pushes). */
  beforeRefUpdate?: () => Promise<void> | void;

  constructor(opts: FakeGitHubOptions = {}) {
    this.owner = opts.owner ?? "octo";
    this.repo = opts.repo ?? "solutions";
    this.login = opts.login ?? "octo";
    this.validTokens = new Set([opts.token ?? FAKE_TOKEN]);
    if (!opts.empty) {
      const tree = this.newId("tree");
      this.trees.set(tree, new Map());
      const sha = this.newId("commit");
      this.commits.set(sha, { sha, tree, parents: [], message: "Initial commit" });
      this.refs.set(opts.branch ?? "main", sha);
    }
  }

  private newId(kind: string): string {
    this.counter += 1;
    return `${kind.charCodeAt(0).toString(16)}${String(this.counter).padStart(38, "0")}`;
  }

  /** Makes the next `times` matching requests fail with the given response. */
  failNext(
    match: { method?: string; pathIncludes?: string },
    status: number,
    opts: { headers?: Record<string, string>; body?: unknown; times?: number } = {},
  ) {
    this.faults.push({
      ...match,
      status,
      headers: opts.headers,
      body: opts.body ?? { message: `injected ${status}` },
      remaining: opts.times ?? 1,
    });
  }

  // ---- inspection helpers -------------------------------------------------

  head(branch = "main"): string | undefined {
    return this.refs.get(branch);
  }

  treeOf(branch = "main"): Map<string, string> {
    const head = this.refs.get(branch);
    if (!head) return new Map();
    return this.trees.get(this.commits.get(head)!.tree)!;
  }

  readFile(path: string, branch = "main"): string | undefined {
    const sha = this.treeOf(branch).get(path);
    return sha ? this.blobs.get(sha) : undefined;
  }

  files(branch = "main"): string[] {
    return [...this.treeOf(branch).keys()].sort();
  }

  /** Commit messages on a branch, newest first. */
  log(branch = "main"): string[] {
    const out: string[] = [];
    let sha = this.refs.get(branch);
    while (sha) {
      const c = this.commits.get(sha)!;
      out.push(c.message);
      sha = c.parents[0];
    }
    return out;
  }

  /** Commits a file directly, as if someone else pushed to the branch. */
  async pushExternal(
    path: string,
    content: string,
    message = "external change",
    branch = "main",
  ): Promise<string> {
    const blob = await gitBlobSha(content);
    this.blobs.set(blob, content);
    const tree = new Map(this.treeOf(branch));
    tree.set(path, blob);
    const treeSha = this.newId("tree");
    this.trees.set(treeSha, tree);
    const sha = this.newId("commit");
    const parent = this.refs.get(branch);
    this.commits.set(sha, { sha, tree: treeSha, parents: parent ? [parent] : [], message });
    this.refs.set(branch, sha);
    return sha;
  }

  // ---- fetch implementation -------------------------------------------------

  readonly fetch: HttpFetch = async (url: string, init: HttpRequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const u = new URL(url);
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const auth = init.headers?.Authorization;
    this.requests.push({ method, path: u.pathname + u.search, body, auth });

    const fault = this.faults.find(
      (f) =>
        f.remaining > 0 &&
        (!f.method || f.method === method) &&
        (!f.pathIncludes || (u.pathname + u.search).includes(f.pathIncludes)),
    );
    if (fault) {
      fault.remaining -= 1;
      return response(fault.status, fault.body, fault.headers);
    }

    if (u.hostname !== "api.github.com") return response(404, { message: "Not Found" });
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    if (!token || !this.validTokens.has(token))
      return response(401, { message: "Bad credentials" });

    const path = decodeURIComponent(u.pathname);
    if (method === "GET" && path === "/user") return response(200, { login: this.login });
    if (method === "GET" && path === "/user/repos") {
      return response(200, [
        {
          name: this.repo,
          full_name: `${this.owner}/${this.repo}`,
          owner: { login: this.owner },
          default_branch: "main",
          private: true,
        },
      ]);
    }

    const prefix = `/repos/${this.owner}/${this.repo}`;
    if (!path.startsWith(`${prefix}/`)) return response(404, { message: "Not Found" });
    const rest = path.slice(prefix.length);

    if (method === "GET" && rest === "/branches")
      return response(
        200,
        [...this.refs.keys()].map((name) => ({ name })),
      );

    if (method === "GET" && rest.startsWith("/git/ref/heads/")) {
      if (this.refs.size === 0) return response(409, { message: "Git Repository is empty." });
      const sha = this.refs.get(rest.slice("/git/ref/heads/".length));
      return sha
        ? response(200, { object: { sha, type: "commit" } })
        : response(404, { message: "Not Found" });
    }
    if (method === "GET" && rest.startsWith("/git/commits/")) {
      const c = this.commits.get(rest.slice("/git/commits/".length));
      return c
        ? response(200, {
            sha: c.sha,
            tree: { sha: c.tree },
            message: c.message,
            parents: c.parents.map((sha) => ({ sha })),
          })
        : response(404, { message: "Not Found" });
    }
    if (method === "GET" && rest.startsWith("/contents/")) {
      const target = rest.slice("/contents/".length);
      const ref = u.searchParams.get("ref") ?? this.refs.get("main");
      const commit = ref
        ? (this.commits.get(ref) ?? this.commits.get(this.refs.get(ref) ?? ""))
        : undefined;
      const tree = commit ? this.trees.get(commit.tree)! : new Map<string, string>();
      const file = tree.get(target);
      if (file)
        return response(200, {
          type: "file",
          name: target.split("/").pop(),
          path: target,
          sha: file,
        });
      const children = new Map<string, { type: string; sha: string }>();
      for (const [p, sha] of tree) {
        if (!p.startsWith(`${target}/`)) continue;
        const [first, ...more] = p.slice(target.length + 1).split("/");
        children.set(first!, more.length ? { type: "dir", sha: "dir" } : { type: "file", sha });
      }
      if (children.size === 0) return response(404, { message: "Not Found" });
      return response(
        200,
        [...children].map(([name, c]) => ({
          name,
          path: `${target}/${name}`,
          sha: c.sha,
          type: c.type,
        })),
      );
    }
    if (method === "GET" && rest.startsWith("/git/blobs/")) {
      const content = this.blobs.get(rest.slice("/git/blobs/".length));
      return content === undefined
        ? response(404, { message: "Not Found" })
        : response(200, { content: base64(content), encoding: "base64" });
    }
    if (method === "POST" && rest === "/git/blobs") {
      const raw = String(body?.content ?? "");
      const content = body?.encoding === "base64" ? decodeBase64Utf8(raw) : raw;
      const sha = await gitBlobSha(content);
      this.blobs.set(sha, content);
      return response(201, { sha });
    }
    if (method === "POST" && rest === "/git/trees") {
      const baseSha = body?.base_tree as string | undefined;
      const base = baseSha ? this.trees.get(baseSha) : new Map<string, string>();
      if (!base) return response(422, { message: "base_tree not found" });
      const tree = new Map(base);
      for (const e of body?.tree as { path: string; sha: string }[]) {
        if (!this.blobs.has(e.sha)) return response(422, { message: "blob not found" });
        tree.set(e.path, e.sha);
      }
      const sha = this.newId("tree");
      this.trees.set(sha, tree);
      return response(201, { sha });
    }
    if (method === "POST" && rest === "/git/commits") {
      const tree = body?.tree as string;
      if (!this.trees.has(tree)) return response(422, { message: "tree not found" });
      const sha = this.newId("commit");
      this.commits.set(sha, {
        sha,
        tree,
        parents: body?.parents as string[],
        message: body?.message as string,
      });
      return response(201, { sha });
    }
    if (method === "PATCH" && rest.startsWith("/git/refs/heads/")) {
      const branch = rest.slice("/git/refs/heads/".length);
      await this.beforeRefUpdate?.();
      const current = this.refs.get(branch);
      if (!current) return response(422, { message: "Reference does not exist" });
      const next = this.commits.get(body?.sha as string);
      if (!next) return response(422, { message: "Object does not exist" });
      if (!body?.force && next.parents[0] !== current)
        return response(422, { message: "Update is not a fast forward" });
      this.refs.set(branch, next.sha);
      return response(200, { object: { sha: next.sha } });
    }
    if (method === "GET" && rest === "/commits") {
      const filePath = u.searchParams.get("path") ?? "";
      let sha = this.refs.get(u.searchParams.get("sha") ?? "main");
      while (sha) {
        const c = this.commits.get(sha)!;
        const parent = c.parents[0] ? this.commits.get(c.parents[0]) : undefined;
        const mine = this.trees.get(c.tree)!.get(filePath);
        const theirs = parent ? this.trees.get(parent.tree)!.get(filePath) : undefined;
        if (mine !== theirs) return response(200, [{ sha }]);
        sha = c.parents[0];
      }
      return response(200, []);
    }
    return response(404, { message: `Fake GitHub has no route for ${method} ${rest}` });
  };
}
