import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { Cipher, hashSecret, newSecret, sameHash } from "../src/crypto.js";
import { createLogger } from "../src/logger.js";

const KEY = randomBytes(32).toString("base64");
const ORIGIN = `chrome-extension://${"a".repeat(32)}`;
const env = (extra: Record<string, string> = {}) => ({
  DATABASE_URL: "postgres://u:p@postgres:5432/db",
  REDIS_URL: "redis://redis:6379",
  APP_ENCRYPTION_KEY: KEY,
  EXTENSION_ORIGIN: ORIGIN,
  ...extra,
});

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig(env());
    expect(c).toMatchObject({
      port: 8787,
      uploadMaxAttempts: 6,
      purgeSourceOnSuccess: true,
      currentKeyId: "k1",
      logLevel: "info",
      host: "127.0.0.1",
    });
    expect(c.encryptionKeys.get("k1")).toHaveLength(32);
  });

  it("names bad variables without echoing their values", () => {
    const secret = "c2hvcnQta2V5"; // valid base64, wrong length
    try {
      loadConfig(env({ APP_ENCRYPTION_KEY: secret, EXTENSION_ORIGIN: "https://evil.example" }));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const msg = (err as Error).message;
      expect(msg).toContain("APP_ENCRYPTION_KEY");
      expect(msg).toContain("EXTENSION_ORIGIN");
      expect(msg).not.toContain(secret);
      expect(msg).not.toContain("evil.example");
    }
    expect(() => loadConfig({})).toThrow(/DATABASE_URL.*REDIS_URL/s);
  });

  it("parses old keys for rotation and rejects malformed ones", () => {
    const old = randomBytes(32).toString("base64");
    const c = loadConfig(
      env({ APP_ENCRYPTION_KEY_ID: "k2", APP_ENCRYPTION_OLD_KEYS: `k1:${old}` }),
    );
    expect([...c.encryptionKeys.keys()]).toEqual(["k2", "k1"]);
    expect(() => loadConfig(env({ APP_ENCRYPTION_OLD_KEYS: "k0:short" }))).toThrow(
      /APP_ENCRYPTION_OLD_KEYS is malformed/,
    );
    expect(() => loadConfig(env({ APP_ENCRYPTION_OLD_KEYS: `k1:${old}` }))).toThrow(/malformed/);
  });

  it("parses booleans strictly", () => {
    expect(loadConfig(env({ PURGE_SOURCE_ON_SUCCESS: "false" })).purgeSourceOnSuccess).toBe(false);
    expect(() => loadConfig(env({ PURGE_SOURCE_ON_SUCCESS: "nope" }))).toThrow(ConfigError);
  });
});

describe("Cipher", () => {
  const k1 = randomBytes(32);
  const k2 = randomBytes(32);

  it("round-trips with a fresh IV per record", () => {
    const c = new Cipher(new Map([["k1", k1]]), "k1");
    const a = c.seal("gho_secret", "user:1");
    const b = c.seal("gho_secret", "user:1");
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.ciphertext).not.toContain("gho_secret");
    expect(c.open(a, "user:1")).toBe("gho_secret");
  });

  it("rejects tampering, a wrong context and unknown keys", () => {
    const c = new Cipher(new Map([["k1", k1]]), "k1");
    const sealed = c.seal("gho_secret", "user:1");
    const raw = Buffer.from(sealed.ciphertext, "base64");
    raw[raw.length - 1]! ^= 1;
    expect(() => c.open({ ...sealed, ciphertext: raw.toString("base64") }, "user:1")).toThrow();
    expect(() => c.open(sealed, "user:2")).toThrow();
    expect(() => c.open({ ...sealed, keyId: "k9" }, "user:1")).toThrow(/not configured/);
  });

  it("reads records sealed with a rotated-out key", () => {
    const before = new Cipher(new Map([["k1", k1]]), "k1").seal("old");
    const after = new Cipher(
      new Map([
        ["k2", k2],
        ["k1", k1],
      ]),
      "k2",
    );
    expect(after.open(before)).toBe("old");
    expect(after.seal("new").keyId).toBe("k2");
  });

  it("refuses to start without the current key", () => {
    expect(() => new Cipher(new Map(), "k1")).toThrow(/missing/);
  });
});

describe("secret hashing", () => {
  it("hashes and compares in constant time", () => {
    const s = newSecret();
    expect(s.length).toBeGreaterThanOrEqual(43);
    expect(sameHash(hashSecret(s), hashSecret(s))).toBe(true);
    expect(sameHash(hashSecret(s), hashSecret(s + "x"))).toBe(false);
    expect(sameHash(hashSecret(s), "")).toBe(false);
    expect(sameHash("", "")).toBe(false);
  });
});

describe("logger", () => {
  it("writes JSON lines, filters by level and redacts secrets", () => {
    const lines: string[] = [];
    const log = createLogger("info", (l) => lines.push(l)).child({ component: "test" });
    log.debug("hidden");
    log.info("upload failed for Bearer abcdefghijkl", {
      token: "anything",
      accessToken: "x",
      sourceCode: "int main(){}",
      problemKey: "4A",
      err: new Error(`bad credentials ${["ghp", "abcdefghijklmnopqrstuv"].join("_")}`),
      nested: { url: "https://x/?access_token=zzz" },
    });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({
      level: "info",
      component: "test",
      token: "[REDACTED]",
      accessToken: "[REDACTED]",
      sourceCode: "[REDACTED]",
      problemKey: "4A",
    });
    expect(lines[0]).not.toMatch(/abcdefghijkl|ghp_|zzz|int main/);
  });
});
