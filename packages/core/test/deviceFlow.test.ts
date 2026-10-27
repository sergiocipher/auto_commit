import { describe, expect, it } from "vitest";
import { pollDeviceFlow, startDeviceFlow, type HttpFetch } from "../src/index.js";

function fakeFetch(
  handler: (url: string, body: Record<string, string>) => [number, unknown],
): HttpFetch & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string, init?: { body?: string }) => {
    calls.push(url);
    const body = Object.fromEntries(new URLSearchParams(init?.body ?? ""));
    const [status, json] = handler(url, body);
    return { status, headers: { get: () => null }, text: async () => JSON.stringify(json) };
  }) as unknown as HttpFetch & { calls: string[] };
  f.calls = calls;
  return f;
}

const NOW = 1_700_000_000_000;

describe("device flow", () => {
  it("starts with the client id and repo scope", async () => {
    let seen: Record<string, string> = {};
    const fetch = fakeFetch((_u, body) => {
      seen = body;
      return [
        200,
        {
          device_code: "dc",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        },
      ];
    });
    const auth = await startDeviceFlow(fetch, "Ov23test", NOW);
    expect(seen).toEqual({ client_id: "Ov23test", scope: "repo" });
    expect(auth).toEqual({
      deviceCode: "dc",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      expiresAt: NOW + 900_000,
      intervalSec: 5,
    });
  });

  it("explains a refused start (device flow disabled)", async () => {
    const fetch = fakeFetch(() => [400, { error: "device_flow_disabled" }]);
    await expect(startDeviceFlow(fetch, "Ov23test", NOW)).rejects.toThrow(
      /device_flow_disabled.*Device Flow enabled/,
    );
    await expect(startDeviceFlow(fetch, "", NOW)).rejects.toThrow(/client ID is not configured/);
  });

  it.each([
    [{ error: "authorization_pending" }, { status: "pending", intervalSec: 5 }],
    [
      { error: "slow_down", interval: 10 },
      { status: "pending", intervalSec: 10 },
    ],
    [{ error: "expired_token" }, { status: "expired" }],
    [{ error: "access_denied" }, { status: "denied" }],
    [
      { access_token: "gho_x", scope: "repo" },
      { status: "authorized", accessToken: "gho_x", scopes: ["repo"] },
    ],
    [{ error: "weird" }, { status: "error", message: "weird" }],
  ])("poll %j", async (json, expected) => {
    const fetch = fakeFetch((_u, body) => {
      expect(body.grant_type).toBe("urn:ietf:params:oauth:grant-type:device_code");
      return [200, json];
    });
    expect(
      await pollDeviceFlow(
        fetch,
        "Ov23test",
        { deviceCode: "dc", intervalSec: 5, expiresAt: NOW + 1 },
        NOW,
      ),
    ).toEqual(expected);
  });

  it("reports expiry locally without calling GitHub", async () => {
    const fetch = fakeFetch(() => [200, {}]);
    expect(
      await pollDeviceFlow(fetch, "x", { deviceCode: "dc", intervalSec: 5, expiresAt: NOW }, NOW),
    ).toEqual({ status: "expired" });
    expect(fetch.calls).toHaveLength(0);
  });
});
