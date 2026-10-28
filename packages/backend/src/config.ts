import { z } from "zod";

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

/** 32 bytes as base64 (AES-256). */
const Base64Key = z
  .string()
  .min(1, "is required")
  .refine((s) => Buffer.from(s, "base64").length === 32, "must be 32 bytes, base64-encoded");

const Bool = z
  .enum(["true", "false", "1", "0"])
  .default("true")
  .transform((v) => v === "true" || v === "1");

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  /** Localhost by default (spec §11); compose sets 0.0.0.0 inside the container network. */
  HOST: z.string().min(1).default("127.0.0.1"),
  DATABASE_URL: z.string().min(1, "is required"),
  REDIS_URL: z.string().min(1, "is required"),
  GITHUB_CLIENT_ID: z.string().default(""),
  APP_ENCRYPTION_KEY: Base64Key,
  APP_ENCRYPTION_KEY_ID: z.string().regex(KEY_ID).default("k1"),
  /** Previous keys kept for decryption during rotation: "id:base64,id:base64". */
  APP_ENCRYPTION_OLD_KEYS: z.string().default(""),
  EXTENSION_ORIGIN: z
    .string()
    .regex(/^chrome-extension:\/\/[a-p]{32}$/, "must be chrome-extension://<32-letter id>"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  UPLOAD_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(6),
  PURGE_SOURCE_ON_SUCCESS: Bool,
  RECONCILE_INTERVAL_MS: z.coerce.number().int().min(5_000).default(120_000),
});

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  redisUrl: string;
  githubClientId: string;
  encryptionKeys: Map<string, Buffer>;
  currentKeyId: string;
  extensionOrigin: string;
  logLevel: "debug" | "info" | "warn" | "error";
  uploadMaxAttempts: number;
  purgeSourceOnSuccess: boolean;
  reconcileIntervalMs: number;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

/**
 * Validates the environment. Error messages name the offending variables
 * but never echo their values (they may be secrets).
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`);
    throw new ConfigError(`Invalid configuration: ${problems.join("; ")}`);
  }
  const e = parsed.data;
  const keys = new Map<string, Buffer>([
    [e.APP_ENCRYPTION_KEY_ID, Buffer.from(e.APP_ENCRYPTION_KEY, "base64")],
  ]);
  for (const entry of e.APP_ENCRYPTION_OLD_KEYS.split(",").filter(Boolean)) {
    const [id = "", key = ""] = entry.split(":");
    const bytes = Buffer.from(key, "base64");
    if (!KEY_ID.test(id) || bytes.length !== 32 || keys.has(id))
      throw new ConfigError("Invalid configuration: APP_ENCRYPTION_OLD_KEYS is malformed");
    keys.set(id, bytes);
  }
  return {
    port: e.PORT,
    host: e.HOST,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    githubClientId: e.GITHUB_CLIENT_ID,
    encryptionKeys: keys,
    currentKeyId: e.APP_ENCRYPTION_KEY_ID,
    extensionOrigin: e.EXTENSION_ORIGIN,
    logLevel: e.LOG_LEVEL,
    uploadMaxAttempts: e.UPLOAD_MAX_ATTEMPTS,
    purgeSourceOnSuccess: e.PURGE_SOURCE_ON_SUCCESS,
    reconcileIntervalMs: e.RECONCILE_INTERVAL_MS,
  };
}
