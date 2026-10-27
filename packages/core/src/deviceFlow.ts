import { z } from "zod";
import { networkError, UploadError } from "./errors.js";
import type { HttpFetch } from "./runtime.js";

export const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
export const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
/** OAuth Apps only support classic scopes; `repo` is needed for private repos. */
export const DEFAULT_SCOPE = "repo";

const DeviceCodeSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.url(),
  expires_in: z.number().positive(),
  interval: z.number().nonnegative().default(5),
});

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalSec: number;
}

export type DevicePollResult =
  | { status: "authorized"; accessToken: string; scopes: string[] }
  | { status: "pending"; intervalSec: number }
  | { status: "expired" }
  | { status: "denied" }
  | { status: "error"; message: string };

async function postForm(
  fetch: HttpFetch,
  url: string,
  params: Record<string, string>,
  context: string,
) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&"),
    });
  } catch (err) {
    throw networkError(err, context);
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UploadError(
      res.status >= 500 ? "retryable" : "permanent",
      `GitHub returned ${res.status} while ${context}`,
    );
  }
  return { status: res.status, json };
}

export async function startDeviceFlow(
  fetch: HttpFetch,
  clientId: string,
  now: number,
  scope = DEFAULT_SCOPE,
): Promise<DeviceAuthorization> {
  if (!clientId) throw new UploadError("permanent", "GitHub OAuth client ID is not configured.");
  const { status, json } = await postForm(
    fetch,
    GITHUB_DEVICE_CODE_URL,
    { client_id: clientId, scope },
    "starting GitHub sign-in",
  );
  const parsed = DeviceCodeSchema.safeParse(json);
  if (status !== 200 || !parsed.success) {
    const err = (json as { error_description?: unknown; error?: unknown }) ?? {};
    const msg =
      typeof err.error_description === "string"
        ? err.error_description
        : typeof err.error === "string"
          ? err.error
          : `status ${status}`;
    throw new UploadError(
      "permanent",
      `GitHub refused device sign-in (${msg}). Is Device Flow enabled on the OAuth App?`,
    );
  }
  return {
    deviceCode: parsed.data.device_code,
    userCode: parsed.data.user_code,
    verificationUri: parsed.data.verification_uri,
    expiresAt: now + parsed.data.expires_in * 1000,
    intervalSec: parsed.data.interval,
  };
}

/** One poll of the token endpoint. Callers wait `intervalSec` between polls. */
export async function pollDeviceFlow(
  fetch: HttpFetch,
  clientId: string,
  auth: Pick<DeviceAuthorization, "deviceCode" | "intervalSec" | "expiresAt">,
  now: number,
): Promise<DevicePollResult> {
  if (now >= auth.expiresAt) return { status: "expired" };
  const { json } = await postForm(
    fetch,
    GITHUB_ACCESS_TOKEN_URL,
    {
      client_id: clientId,
      device_code: auth.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    },
    "completing GitHub sign-in",
  );
  const body = (json ?? {}) as {
    access_token?: unknown;
    scope?: unknown;
    error?: unknown;
    interval?: unknown;
  };
  if (typeof body.access_token === "string" && body.access_token) {
    const scopes = typeof body.scope === "string" ? body.scope.split(/[,\s]+/).filter(Boolean) : [];
    return { status: "authorized", accessToken: body.access_token, scopes };
  }
  switch (body.error) {
    case "authorization_pending":
      return { status: "pending", intervalSec: auth.intervalSec };
    case "slow_down":
      return {
        status: "pending",
        intervalSec: typeof body.interval === "number" ? body.interval : auth.intervalSec + 5,
      };
    case "expired_token":
      return { status: "expired" };
    case "access_denied":
      return { status: "denied" };
    default:
      return {
        status: "error",
        message: typeof body.error === "string" ? body.error : "unexpected response",
      };
  }
}
