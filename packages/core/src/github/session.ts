import { pollDeviceFlow, startDeviceFlow, type DeviceAuthorization } from "../deviceFlow.js";
import type { Clock, HttpFetch } from "../runtime.js";
import { GitHubClient } from "./client.js";

export interface GitHubConnection {
  token: string;
  scopes: string[];
  login: string;
  connectedAt: number;
}

export interface PendingDeviceAuth extends DeviceAuthorization {
  nextPollAt: number;
}

/**
 * Where a GitHub session lives: chrome.storage in local mode, Postgres
 * (token encrypted at rest) in the backend.
 */
export interface GitHubSessionStore {
  getConnection(): Promise<GitHubConnection | undefined>;
  setConnection(connection: GitHubConnection): Promise<void>;
  clearConnection(): Promise<void>;
  getPending(): Promise<PendingDeviceAuth | undefined>;
  setPending(pending: PendingDeviceAuth): Promise<void>;
  clearPending(): Promise<void>;
}

/** What UIs may see. Never includes the token or device code. */
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
 * GitHub OAuth device flow plus token storage. The token is read only to
 * authorize API calls and is never part of a returned status.
 */
export class GitHubSession {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: GitHubSessionStore,
    private readonly fetch: HttpFetch,
    private readonly clientId: string,
    private readonly now: Clock,
  ) {}

  /** Runs read-modify-write cycles one at a time (start, poll and disconnect race otherwise). */
  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  async getToken(): Promise<string | undefined> {
    return (await this.store.getConnection())?.token;
  }

  async status(): Promise<GitHubStatus> {
    const [conn, pending] = await Promise.all([
      this.store.getConnection(),
      this.store.getPending(),
    ]);
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
      const auth = await startDeviceFlow(this.fetch, this.clientId, this.now());
      await this.store.setPending({ ...auth, nextPollAt: this.now() + auth.intervalSec * 1000 });
      return {
        state: "pending",
        userCode: auth.userCode,
        verificationUri: auth.verificationUri,
        retryInMs: auth.intervalSec * 1000,
      };
    });
  }

  /** Polls GitHub once if due. Safe to call repeatedly (page and background timer). */
  poll(): Promise<ConnectProgress> {
    return this.lock(async () => {
      const conn = await this.store.getConnection();
      if (conn) return { state: "connected", login: conn.login };
      const p = await this.store.getPending();
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
          await this.store.setPending({
            ...p,
            intervalSec: result.intervalSec,
            nextPollAt: now + result.intervalSec * 1000,
          });
          return pendingReply(result.intervalSec * 1000);
        case "authorized": {
          const user = await new GitHubClient(this.fetch, result.accessToken, this.now).request<{
            login: string;
          }>("GET", "/user", "reading the GitHub account");
          await this.store.setConnection({
            token: result.accessToken,
            scopes: result.scopes,
            login: user.login,
            connectedAt: now,
          });
          await this.store.clearPending();
          return { state: "connected", login: user.login };
        }
        case "expired":
        case "denied":
          await this.store.clearPending();
          return { state: result.status };
        case "error":
          await this.store.clearPending();
          return { state: "error", message: `GitHub sign-in failed: ${result.message}` };
      }
    });
  }

  disconnect(): Promise<void> {
    return this.lock(async () => {
      await this.store.clearConnection();
      await this.store.clearPending();
    });
  }
}

export interface RepoSummary {
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
}

type TokenSource = () => Promise<string | undefined>;

async function requireToken(getToken: TokenSource): Promise<string> {
  const token = await getToken();
  if (!token) throw new Error("GitHub is not connected.");
  return token;
}

/** Repositories the user can push to, for the settings picker. */
export async function listRepos(
  getToken: TokenSource,
  fetch: HttpFetch,
  now: Clock,
): Promise<RepoSummary[]> {
  const repos = await new GitHubClient(fetch, await requireToken(getToken), now).request<
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
  getToken: TokenSource,
  fetch: HttpFetch,
  now: Clock,
  owner: string,
  name: string,
): Promise<string[]> {
  const branches = await new GitHubClient(fetch, await requireToken(getToken), now).request<
    { name: string }[]
  >(
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches?per_page=100`,
    "listing branches",
  );
  return branches.map((b) => b.name);
}
