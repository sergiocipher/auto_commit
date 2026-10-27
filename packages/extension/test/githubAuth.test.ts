import { describe, expect, it } from "vitest";
import type { HttpFetch } from "@cst/core";
import { FakeGitHub, FAKE_TOKEN as TOKEN } from "@cst/core/testing";
import {
  GitHubAuth,
  GITHUB_DEVICE_KEY,
  GITHUB_TOKEN_KEY,
  listRepos,
} from "../src/background/githubAuth.js";
import { MemoryStore } from "./helpers.js";

function setup(tokenReply: Record<string, unknown> = { access_token: TOKEN, scope: "repo" }) {
  const gh = new FakeGitHub({ login: "octocat" });
  let now = 1_700_000_000_000;
  const login: string[] = [];
  const fetch: HttpFetch = async (url, init) => {
    if (url.startsWith("https://github.com/login/")) {
      login.push(url);
      const json = url.endsWith("/device/code")
        ? {
            device_code: "secret-device-code",
            user_code: "WDJB-MJHT",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 5,
          }
        : tokenReply;
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(json) };
    }
    return gh.fetch(url, init);
  };
  const store = new MemoryStore();
  const auth = new GitHubAuth(store, fetch, "Ov23test", () => now);
  return { gh, store, auth, fetch, login, advance: (ms: number) => (now += ms), now: () => now };
}

describe("GitHubAuth", () => {
  it("runs the device flow and stores the token only in service-worker storage", async () => {
    const t = setup();
    expect(await t.auth.start()).toMatchObject({ state: "pending", userCode: "WDJB-MJHT" });
    const status = await t.auth.status();
    expect(status.pending?.userCode).toBe("WDJB-MJHT");
    expect(JSON.stringify(status)).not.toContain("secret-device-code");

    // Too early: no request to GitHub.
    expect(await t.auth.poll()).toMatchObject({ state: "pending" });
    expect(t.login).toHaveLength(1);

    t.advance(5000);
    expect(await t.auth.poll()).toEqual({ state: "connected", login: "octocat" });
    expect(await t.auth.getToken()).toBe(TOKEN);
    expect(await t.auth.status()).toEqual({ connected: true, login: "octocat", scopes: ["repo"] });
    expect(JSON.stringify(await t.auth.status())).not.toContain(TOKEN);
    expect(await t.store.get(GITHUB_DEVICE_KEY)).toBeUndefined();
  });

  it("honors slow_down by lengthening the interval", async () => {
    const t = setup({ error: "slow_down", interval: 10 });
    await t.auth.start();
    t.advance(5000);
    expect(await t.auth.poll()).toMatchObject({ state: "pending", retryInMs: 10_000 });
  });

  it("clears a denied or expired attempt", async () => {
    const denied = setup({ error: "access_denied" });
    await denied.auth.start();
    denied.advance(5000);
    expect(await denied.auth.poll()).toEqual({ state: "denied" });
    expect(await denied.auth.status()).toEqual({ connected: false });

    const expired = setup({ error: "authorization_pending" });
    await expired.auth.start();
    expired.advance(901_000);
    expect(await expired.auth.poll()).toEqual({ state: "expired" });
  });

  it("disconnect deletes the stored token", async () => {
    const t = setup();
    await t.auth.start();
    t.advance(5000);
    await t.auth.poll();
    await t.auth.disconnect();
    expect(await t.store.get(GITHUB_TOKEN_KEY)).toBeUndefined();
    expect(await t.auth.getToken()).toBeUndefined();
  });

  it("lists repositories with the stored token", async () => {
    const t = setup();
    await expect(listRepos(t.auth, t.fetch, t.now)).rejects.toThrow(/not connected/);
    await t.auth.start();
    t.advance(5000);
    await t.auth.poll();
    expect(await listRepos(t.auth, t.fetch, t.now)).toEqual([
      { owner: "octo", name: "solutions", defaultBranch: "main", private: true },
    ]);
  });
});
