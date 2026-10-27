import { classifyResponse, networkError, UploadError } from "../errors.js";
import type { Clock, HttpFetch } from "../runtime.js";

export const GITHUB_API = "https://api.github.com";

export interface RepoRef {
  owner: string;
  name: string;
  branch: string;
}

/** Encodes each path segment; keeps "/" separators (branch names may contain them). */
export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** Thin authenticated JSON client for the GitHub REST API. */
export class GitHubClient {
  constructor(
    private readonly fetch: HttpFetch,
    private readonly token: string,
    private readonly now: Clock,
    private readonly baseUrl = GITHUB_API,
  ) {}

  async request<T>(method: string, path: string, context: string, body?: unknown): Promise<T> {
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw networkError(err, context);
    }
    const text = await res.text();
    if (res.status < 200 || res.status >= 300)
      throw classifyResponse(res, text, this.now(), context);
    if (!text) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new UploadError("retryable", `GitHub returned malformed JSON while ${context}`);
    }
  }

  /** Like request, but resolves to null on 404. */
  async requestOptional<T>(method: string, path: string, context: string): Promise<T | null> {
    try {
      return await this.request<T>(method, path, context);
    } catch (err) {
      if (err instanceof UploadError && err.status === 404) return null;
      throw err;
    }
  }
}
