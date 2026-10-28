import { z } from "zod";
import { UploadSummarySchema, type HttpFetch } from "@cst/core";
import {
  SettingsSchema,
  UploadStatusSchema,
  type Settings,
  type SubmissionEvent,
} from "@cst/shared";
import type { KeyValueStore } from "../storage.js";
import type { ActivityLog } from "./activity.js";
import type { ConnectProgress, GitHubStatus, RepoSummary } from "./githubAuth.js";
import type { GitHubService, UploadHistory, UploadService } from "./handler.js";
import type { DeliveryResult } from "./outbox.js";

export const BACKEND_STORAGE_KEY = "backend:v1";

/** Backends live on this machine; the manifest grants only these origins. */
const LOCAL_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/;

const BackendConfigSchema = z.strictObject({
  url: z.string().regex(LOCAL_ORIGIN),
  token: z.string().min(20).max(200),
  installId: z.string().min(1),
});
export type BackendConfig = z.infer<typeof BackendConfigSchema>;

/** Normalizes a user-entered backend URL to an origin, or null when not allowed. */
export function backendOrigin(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
  return LOCAL_ORIGIN.test(url.origin) ? url.origin : null;
}

export class BackendConfigStore {
  constructor(private readonly store: KeyValueStore) {}

  async get(): Promise<BackendConfig | undefined> {
    const parsed = BackendConfigSchema.safeParse(await this.store.get(BACKEND_STORAGE_KEY));
    return parsed.success ? parsed.data : undefined;
  }

  set(config: BackendConfig): Promise<void> {
    return this.store.set(BACKEND_STORAGE_KEY, BackendConfigSchema.parse(config));
  }

  clear(): Promise<void> {
    return this.store.remove(BACKEND_STORAGE_KEY);
  }
}

/** A backend reply that should be shown to the user. Retryable when the backend was unreachable or busy. */
export class BackendError extends Error {
  override name = "BackendError";
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** Minimal JSON client for the backend API, authenticated with the install's bearer token. */
export class BackendClient {
  constructor(
    private readonly fetch: HttpFetch,
    private readonly config: () => Promise<BackendConfig | undefined>,
  ) {}

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    schema?: z.ZodType<T>,
  ): Promise<T> {
    const config = await this.config();
    if (!config) throw new BackendError("Not paired with a backend.", undefined, false);
    let res;
    try {
      res = await this.fetch(config.url + path, {
        method,
        headers: {
          Authorization: `Bearer ${config.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new BackendError(
        "Backend is not reachable. Is docker compose running?",
        undefined,
        true,
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(await res.text());
    } catch {
      throw new BackendError(
        `Backend returned an unreadable reply (${res.status}).`,
        res.status,
        true,
      );
    }
    if (res.status === 401)
      throw new BackendError(
        "Backend pairing is no longer valid; pair again in Settings.",
        401,
        false,
      );
    if (res.status >= 400) {
      const error = (json as { error?: unknown })?.error;
      const message =
        typeof error === "string" ? error.slice(0, 300) : `Backend error ${res.status}.`;
      throw new BackendError(message, res.status, res.status >= 500 || res.status === 429);
    }
    if (!schema) return json as T;
    const parsed = schema.safeParse(json);
    if (!parsed.success)
      throw new BackendError("Backend reply did not match the expected format.", res.status, false);
    return parsed.data;
  }
}

/** Pairs with a backend using a one-time code; stores the returned bearer token. */
export async function pairBackend(
  fetch: HttpFetch,
  configs: BackendConfigStore,
  input: { url: string; code: string },
): Promise<BackendConfig> {
  const origin = backendOrigin(input.url);
  if (!origin)
    throw new BackendError(
      "Backend URL must be http://127.0.0.1:<port> or http://localhost:<port>.",
      undefined,
      false,
    );
  let res;
  try {
    res = await fetch(`${origin}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: input.code.trim(), name: "Chrome extension" }),
    });
  } catch {
    throw new BackendError("Backend is not reachable. Is docker compose running?", undefined, true);
  }
  const json = (await res.text().then(
    (t) => JSON.parse(t) as unknown,
    () => undefined,
  )) as { token?: unknown; installId?: unknown; error?: unknown } | undefined;
  if (res.status !== 201 || typeof json?.token !== "string" || typeof json.installId !== "string") {
    const error =
      typeof json?.error === "string"
        ? json.error.slice(0, 300)
        : `Pairing failed (${res.status}).`;
    throw new BackendError(error, res.status, false);
  }
  const config = { url: origin, token: json.token, installId: json.installId };
  await configs.set(config);
  return config;
}

const IngestReplySchema = z.object({
  decision: z.string(),
  upload: z.object({ status: UploadStatusSchema, lastError: z.string().optional() }).optional(),
});
const HistorySchema = z.object({
  uploads: z.array(UploadSummarySchema),
  uploadedCount: z.number().int().nonnegative(),
});
const UploadReplySchema = z.object({ upload: UploadSummarySchema });

/**
 * Backend mode: submissions, uploads and GitHub go through the self-hosted
 * API. The extension never sees the GitHub token in this mode.
 */
export class BackendSink {
  constructor(
    private readonly client: BackendClient,
    private readonly activity: ActivityLog,
    private readonly now: () => number,
  ) {}

  /** Outbox delivery. Unreachable or busy backends keep the event in the outbox. */
  readonly deliver = async (event: SubmissionEvent): Promise<DeliveryResult> => {
    try {
      const reply = await this.client.request("POST", "/v1/submissions", event, IngestReplySchema);
      if (!reply.upload) return { kind: "rejected", error: "Platform is disabled on the backend." };
      return {
        kind: "accepted",
        status: reply.upload.status,
        ...(reply.upload.lastError ? { detail: reply.upload.lastError } : {}),
      };
    } catch (err) {
      if (!(err instanceof BackendError)) throw err;
      // 401 stays in the outbox too: re-pairing should not lose the submission.
      if (err.retryable || err.status === 401 || err.status === undefined)
        return { kind: "retry", error: err.message };
      return { kind: "rejected", error: err.message };
    }
  };

  /**
   * Fetches history and mirrors status changes into the activity log, so the
   * popup only shows "Upload successful" once the backend reports SUCCESS.
   * Returns whether any upload is still in progress (worth polling again).
   */
  async refresh(): Promise<{ history: UploadHistory; active: boolean }> {
    const history = await this.client.request(
      "GET",
      "/v1/uploads?limit=100",
      undefined,
      HistorySchema,
    );
    const known = new Map((await this.activity.list()).map((e) => [e.key, e]));
    for (const u of [...history.uploads].reverse()) {
      const entry = known.get(`${u.platform}:${u.submissionId}`);
      if (entry && (entry.status !== u.status || entry.detail !== u.lastError))
        await this.activity.recordJob(u, this.now());
    }
    const active = history.uploads.some((u) =>
      ["RECEIVED", "QUEUED", "UPLOADING", "RETRYING"].includes(u.status),
    );
    return { history, active };
  }

  readonly uploads: UploadService = {
    retry: async (platform, submissionId, options = {}) => {
      if (options.force) {
        const r = await this.client.request(
          "POST",
          "/v1/uploads/force",
          { platform, submissionId },
          UploadReplySchema,
        );
        return r.upload;
      }
      const { history } = await this.refresh();
      const target = history.uploads.find(
        (u) => u.platform === platform && u.submissionId === submissionId,
      );
      if (!target) return undefined;
      const r = await this.client.request(
        "POST",
        `/v1/uploads/${encodeURIComponent(target.id)}/retry`,
        undefined,
        UploadReplySchema,
      );
      return r.upload;
    },
    retryFailed: async () =>
      (
        await this.client.request(
          "POST",
          "/v1/uploads/retry-failed",
          undefined,
          z.object({ queued: z.number() }),
        )
      ).queued,
    history: async () => (await this.refresh()).history,
    // The backend resumes waiting jobs itself when GitHub connects.
    onConnected: async () => undefined,
    clear: async () => {
      await this.client.request("DELETE", "/v1/data");
    },
  };

  readonly github: GitHubService = {
    status: () => this.client.request<GitHubStatus>("GET", "/v1/github"),
    start: () => this.client.request<ConnectProgress>("POST", "/v1/github/device/start"),
    poll: () => this.client.request<ConnectProgress>("POST", "/v1/github/device/poll"),
    disconnect: async () => {
      await this.client.request("DELETE", "/v1/github");
    },
    repos: () => this.client.request<RepoSummary[]>("GET", "/v1/github/repos"),
    branches: (owner, name) =>
      this.client.request<string[]>(
        "GET",
        `/v1/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches`,
      ),
  };

  pushSettings(settings: Settings): Promise<Settings> {
    return this.client.request("PUT", "/v1/settings", settings, SettingsSchema);
  }
}
