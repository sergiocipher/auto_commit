import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { GitHubConnection, GitHubSessionStore, PendingDeviceAuth } from "@cst/core";
import { DEFAULT_SETTINGS, SettingsSchema, type Settings } from "@cst/shared";
import { hashSecret, newSecret, sameHash, type Cipher } from "../crypto.js";
import type { Db } from "./db.js";

/** Single-user deployment: every install belongs to this user (see DECISIONS). */
export const DEFAULT_USER_ID = "local";

export async function ensureUser(db: Db, userId = DEFAULT_USER_ID): Promise<void> {
  await db.query("INSERT INTO users (id) VALUES ($1) ON CONFLICT DO NOTHING", [userId]);
}

export class SettingsRepo {
  constructor(private readonly db: Db) {}

  async get(userId: string): Promise<Settings> {
    const { rows } = await this.db.query<{ data: unknown }>(
      "SELECT data FROM settings WHERE user_id = $1",
      [userId],
    );
    const parsed = SettingsSchema.safeParse(rows[0]?.data);
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  }

  async set(userId: string, settings: Settings): Promise<Settings> {
    const valid = SettingsSchema.parse(settings);
    await this.db.query(
      `INSERT INTO settings (user_id, data, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [userId, JSON.stringify(valid)],
    );
    return valid;
  }
}

const PendingSchema = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUri: z.string(),
  expiresAt: z.number(),
  intervalSec: z.number(),
  nextPollAt: z.number(),
});

/**
 * GitHub session in Postgres. The token and the device code are sealed with
 * AES-256-GCM, bound to the user via associated data, so a row copied to
 * another user does not decrypt.
 */
export class PgSessionStore implements GitHubSessionStore {
  constructor(
    private readonly db: Db,
    private readonly cipher: Cipher,
    private readonly userId: string,
  ) {}

  private aad(kind: string) {
    return `${kind}:${this.userId}`;
  }

  async getConnection(): Promise<GitHubConnection | undefined> {
    const { rows } = await this.db.query<{
      key_id: string;
      token_ciphertext: string;
      scopes: string[];
      login: string;
      connected_at: number;
    }>("SELECT * FROM github_connections WHERE user_id = $1", [this.userId]);
    const r = rows[0];
    if (!r) return undefined;
    const token = this.cipher.open(
      { keyId: r.key_id, ciphertext: r.token_ciphertext },
      this.aad("token"),
    );
    return { token, scopes: r.scopes, login: r.login, connectedAt: r.connected_at };
  }

  async setConnection(c: GitHubConnection): Promise<void> {
    const sealed = this.cipher.seal(c.token, this.aad("token"));
    await this.db.query(
      `INSERT INTO github_connections (user_id, key_id, token_ciphertext, scopes, login, connected_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET key_id = EXCLUDED.key_id,
         token_ciphertext = EXCLUDED.token_ciphertext, scopes = EXCLUDED.scopes,
         login = EXCLUDED.login, connected_at = EXCLUDED.connected_at`,
      [this.userId, sealed.keyId, sealed.ciphertext, c.scopes, c.login, c.connectedAt],
    );
  }

  async clearConnection(): Promise<void> {
    await this.db.query("DELETE FROM github_connections WHERE user_id = $1", [this.userId]);
  }

  async getPending(): Promise<PendingDeviceAuth | undefined> {
    const { rows } = await this.db.query<{ key_id: string; data_ciphertext: string }>(
      "SELECT key_id, data_ciphertext FROM github_device_pending WHERE user_id = $1",
      [this.userId],
    );
    const r = rows[0];
    if (!r) return undefined;
    const json = this.cipher.open(
      { keyId: r.key_id, ciphertext: r.data_ciphertext },
      this.aad("device"),
    );
    const parsed = PendingSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : undefined;
  }

  async setPending(p: PendingDeviceAuth): Promise<void> {
    const sealed = this.cipher.seal(JSON.stringify(p), this.aad("device"));
    await this.db.query(
      `INSERT INTO github_device_pending (user_id, key_id, data_ciphertext, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id) DO UPDATE SET key_id = EXCLUDED.key_id,
         data_ciphertext = EXCLUDED.data_ciphertext, updated_at = now()`,
      [this.userId, sealed.keyId, sealed.ciphertext],
    );
  }

  async clearPending(): Promise<void> {
    await this.db.query("DELETE FROM github_device_pending WHERE user_id = $1", [this.userId]);
  }
}

export const PAIRING_CODE_TTL_MS = 10 * 60_000;

export interface Install {
  id: string;
  userId: string;
}

/** One-time pairing codes and per-install bearer tokens, both stored hashed. */
export class InstallsRepo {
  constructor(private readonly db: Db) {}

  /** Creates a pairing code (shown once to the operator). */
  async createPairingCode(
    userId: string,
    now: number,
  ): Promise<{ code: string; expiresAt: number }> {
    const code = newSecret(9); // 12 base64url characters, typed by hand
    const expiresAt = now + PAIRING_CODE_TTL_MS;
    await this.db.query(
      "INSERT INTO pairing_codes (code_hash, user_id, expires_at) VALUES ($1, $2, $3)",
      [hashSecret(code), userId, new Date(expiresAt)],
    );
    return { code, expiresAt };
  }

  /** Redeems a pairing code once; returns the new install's bearer token, or null. */
  redeem(
    code: string,
    name: string,
    now: number,
  ): Promise<{ token: string; install: Install } | null> {
    return this.db.transaction(async () => {
      const { rows } = await this.db.query<{ user_id: string }>(
        `UPDATE pairing_codes SET used_at = $2
         WHERE code_hash = $1 AND used_at IS NULL AND expires_at > $2
         RETURNING user_id`,
        [hashSecret(code), new Date(now)],
      );
      const userId = rows[0]?.user_id;
      if (!userId) return null;
      const token = newSecret();
      const install = { id: randomUUID(), userId };
      await this.db.query(
        "INSERT INTO installs (id, user_id, name, token_hash) VALUES ($1, $2, $3, $4)",
        [install.id, userId, name, hashSecret(token)],
      );
      return { token, install };
    });
  }

  /** Resolves a bearer token to its install, or null. */
  async authenticate(token: string): Promise<Install | null> {
    const hash = hashSecret(token);
    const { rows } = await this.db.query<{ id: string; user_id: string; token_hash: string }>(
      "SELECT id, user_id, token_hash FROM installs WHERE token_hash = $1",
      [hash],
    );
    const r = rows[0];
    if (!r || !sameHash(r.token_hash, hash)) return null;
    await this.db.query("UPDATE installs SET last_seen_at = now() WHERE id = $1", [r.id]);
    return { id: r.id, userId: r.user_id };
  }

  async revoke(installId: string): Promise<void> {
    await this.db.query("DELETE FROM installs WHERE id = $1", [installId]);
  }
}
