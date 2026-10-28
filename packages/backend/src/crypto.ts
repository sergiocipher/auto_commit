import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export interface Sealed {
  keyId: string;
  /** base64(iv[12] | tag[16] | ciphertext) */
  ciphertext: string;
}

/**
 * AES-256-GCM with a random 96-bit IV per record. Every record names the
 * key that sealed it, so keys can rotate: new records use the current key,
 * old records stay readable while their key is listed.
 */
export class Cipher {
  constructor(
    private readonly keys: ReadonlyMap<string, Buffer>,
    private readonly currentKeyId: string,
  ) {
    const key = keys.get(currentKeyId);
    if (!key || key.length !== 32) throw new Error("current encryption key is missing");
  }

  seal(plaintext: string, aad = ""): Sealed {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.keys.get(this.currentKeyId)!, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      keyId: this.currentKeyId,
      ciphertext: Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64"),
    };
  }

  /** Throws on an unknown key, tampering or a wrong `aad`. */
  open(sealed: Sealed, aad = ""): string {
    const key = this.keys.get(sealed.keyId);
    if (!key) throw new Error(`encryption key "${sealed.keyId}" is not configured`);
    const raw = Buffer.from(sealed.ciphertext, "base64");
    if (raw.length < 28) throw new Error("ciphertext is truncated");
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  }
}

/** A new random bearer token or pairing code (base64url). */
export function newSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Bearer tokens and pairing codes are stored only as SHA-256 hashes. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Constant-time comparison of two hex digests. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
