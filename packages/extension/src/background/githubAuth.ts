import { z } from "zod";
import {
  GitHubSession,
  listBranches as coreListBranches,
  listRepos as coreListRepos,
  type Clock,
  type GitHubSessionStore,
  type HttpFetch,
  type RepoSummary,
} from "@cst/core";
import type { KeyValueStore } from "../storage.js";

export type { ConnectProgress, GitHubStatus, RepoSummary } from "@cst/core";

export const GITHUB_TOKEN_KEY = "github:v1";
export const GITHUB_DEVICE_KEY = "github-device:v1";

const ConnectionSchema = z.object({
  token: z.string().min(1),
  scopes: z.array(z.string()),
  login: z.string(),
  connectedAt: z.number(),
});

const PendingSchema = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUri: z.string(),
  expiresAt: z.number(),
  intervalSec: z.number(),
  nextPollAt: z.number(),
});

/** Session storage in chrome.storage.local, read only by the service worker. */
export function kvSessionStore(store: KeyValueStore): GitHubSessionStore {
  return {
    async getConnection() {
      const parsed = ConnectionSchema.safeParse(await store.get(GITHUB_TOKEN_KEY));
      return parsed.success ? parsed.data : undefined;
    },
    setConnection: (c) => store.set(GITHUB_TOKEN_KEY, c),
    clearConnection: () => store.remove(GITHUB_TOKEN_KEY),
    async getPending() {
      const parsed = PendingSchema.safeParse(await store.get(GITHUB_DEVICE_KEY));
      return parsed.success ? parsed.data : undefined;
    },
    setPending: (p) => store.set(GITHUB_DEVICE_KEY, p),
    clearPending: () => store.remove(GITHUB_DEVICE_KEY),
  };
}

/** GitHub device flow and token storage for local mode. Lives only in the service worker. */
export class GitHubAuth extends GitHubSession {
  constructor(store: KeyValueStore, fetch: HttpFetch, clientId: string, now: Clock) {
    super(kvSessionStore(store), fetch, clientId, now);
  }
}

export function listRepos(auth: GitHubAuth, fetch: HttpFetch, now: Clock): Promise<RepoSummary[]> {
  return coreListRepos(() => auth.getToken(), fetch, now);
}

export function listBranches(
  auth: GitHubAuth,
  fetch: HttpFetch,
  now: Clock,
  owner: string,
  name: string,
): Promise<string[]> {
  return coreListBranches(() => auth.getToken(), fetch, now, owner, name);
}
