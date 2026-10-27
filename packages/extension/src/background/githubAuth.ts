import { z } from "zod";
import {
  GitHubClient,
  pollDeviceFlow,
  startDeviceFlow,
  type Clock,
  type DeviceAuthorization,
  type HttpFetch,
} from "@cst/core";
import type { KeyValueStore } from "../storage.js";
import { createSerialLock } from "../lock.js";

export const GITHUB_TOKEN_KEY = "github:v1";
export const GITHUB_DEVICE_KEY = "github-device:v1";

const ConnectionSchema = z.object({
  token: z.string().min(1),
  scopes: z.array(z.string()),
  login: z.string(),
  connectedAt: z.number(),
});
type Connection = z.infer<typeof ConnectionSchema>;

const PendingSchema = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUri: z.string(),
  expiresAt: z.number(),
  intervalSec: z.number(),
  nextPollAt: z.number(),
});
type Pending = z.infer<typeof PendingSchema>;

/** What the popup/options may see. Never includes the token or device code. */
export interface GitHubStatus {
  connected: boolean;
  login?: string;
  scopes?: string[];
  pending?: { userCode: string; verificationUri: string; expiresAt: number };
}

export type ConnectProgress =
  | { state: "connected"; login: string }
  | { state: "pending"; userCode: string; verificationUri: string; retryInMs: number }
  | { state: "expired" }
  | { state: "denied" }
  | { state: "idle" }
  | { state: "error"; message: string };

/**
 * GitHub OAuth device flow and token storage for local mode. Lives only in
 * the service worker; the token is read solely to authorize API calls.
 */
export class GitHubAuth {
  private readonly lock = createSerialLock();

  constructor(
    private readonly store: KeyValueStore,
    private readonly fetch: HttpFetch,
    private readonly clientId: string,
    private readonly now: Clock,
  ) {}

  private async connection(): Promise<Connection | undefined> {
    const parsed = ConnectionSchema.safeParse(await this.store.get(GITHUB_TOKEN_KEY));
    return parsed.success ? parsed.data : undefined;
  }

  private async pending(): Promise<Pending | undefined> {
    const parsed = PendingSchema.safeParse(await this.store.get(GITHUB_DEVICE_KEY));
    return parsed.success ? parsed.data : undefined;
  }

  async getToken(): Promise<string | undefined> {
    return (await this.connection())?.token;
  }

  async status(): Promise<GitHubStatus> {
    const [conn, pending] = await Promise.all([this.connection(), this.pending()]);
    if (conn) return { connected: true, login: conn.login, scopes: conn.scopes };
    if (pending && pending.expiresAt > this.now()) {
      return {
        connected: false,
        pending: {
          userCode: pending.userCode,
          verificationUri: pending.verificationUri,
          expiresAt: pending.expiresAt,
        },
      };
    }
    return { connected: false };
  }

  start(): Promise<ConnectProgress> {
    return this.lock(async () => {
      const auth: DeviceAuthorization = await startDeviceFlow(
        this.fetch,
        this.clientId,
        this.now(),
      );
      await this.store.set(GITHUB_DEVICE_KEY, {
        ...auth,
        nextPollAt: this.now() + auth.intervalSec * 1000,
      } satisfies Pending);
      return {
        state: "pending",
        userCode: auth.userCode,
        verificationUri: auth.verificationUri,
        retryInMs: auth.intervalSec * 1000,
      };
    });
  }

  /** Polls GitHub once if due. Safe to call from both the page and an alarm. */
  poll(): Promise<ConnectProgress> {
    return this.lock(async () => {
      const conn = await this.connection();
      if (conn) return { state: "connected", login: conn.login };
      const p = await this.pending();
      if (!p) return { state: "idle" };
      const now = this.now();
      const pendingReply = (ms: number): ConnectProgress => ({
        state: "pending",
        userCode: p.userCode,
        verificationUri: p.verificationUri,
        retryInMs: ms,
      });
      if (now < p.nextPollAt) return pendingReply(p.nextPollAt - now);
      const result = await pollDeviceFlow(this.fetch, this.clientId, p, now);
      switch (result.status) {
        case "pending":
          await this.store.set(GITHUB_DEVICE_KEY, {
            ...p,
            intervalSec: result.intervalSec,
            nextPollAt: now + result.intervalSec * 1000,
          });
          return pendingReply(result.intervalSec * 1000);
        case "authorized": {
          const user = await new GitHubClient(this.fetch, result.accessToken, this.now).request<{
            login: string;
          }>("GET", "/user", "reading the GitHub account");
          await this.store.set(GITHUB_TOKEN_KEY, {
            token: result.accessToken,
            scopes: result.scopes,
            login: user.login,
            connectedAt: now,
          } satisfies Connection);
          await this.store.remove(GITHUB_DEVICE_KEY);
          return { state: "connected", login: user.login };
        }
        case "expired":
        case "denied":
          await this.store.remove(GITHUB_DEVICE_KEY);
          return { state: result.status };
        case "error":
          await this.store.remove(GITHUB_DEVICE_KEY);
          return { state: "error", message: `GitHub sign-in failed: ${result.message}` };
      }
    });
  }

  disconnect(): Promise<void> {
    return this.lock(async () => {
      await this.store.remove(GITHUB_TOKEN_KEY);
      await this.store.remove(GITHUB_DEVICE_KEY);
    });
  }
}

export interface RepoSummary {
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
}

/** Repository/branch listing for the settings picker (uses the stored token). */
export async function listRepos(
  auth: GitHubAuth,
  fetch: HttpFetch,
  now: Clock,
): Promise<RepoSummary[]> {
  const token = await auth.getToken();
  if (!token) throw new Error("GitHub is not connected.");
  const repos = await new GitHubClient(fetch, token, now).request<
    { name: string; owner: { login: string }; default_branch: string; private: boolean }[]
  >(
    "GET",
    "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator",
    "listing repositories",
  );
  return repos.map((r) => ({
    owner: r.owner.login,
    name: r.name,
    defaultBranch: r.default_branch,
    private: r.private,
  }));
}

export async function listBranches(
  auth: GitHubAuth,
  fetch: HttpFetch,
  now: Clock,
  owner: string,
  name: string,
): Promise<string[]> {
  const token = await auth.getToken();
  if (!token) throw new Error("GitHub is not connected.");
  const branches = await new GitHubClient(fetch, token, now).request<{ name: string }[]>(
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches?per_page=100`,
    "listing branches",
  );
  return branches.map((b) => b.name);
}
