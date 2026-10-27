// Minimal structural types so this module needs neither DOM nor Node typings;
// both runtimes expose WebCrypto and TextEncoder on globalThis.
interface Digester {
  digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer>;
}
interface Utf8Encoder {
  encode(input: string): Uint8Array;
}

const g = globalThis as unknown as {
  crypto?: { subtle?: Digester };
  TextEncoder?: new () => Utf8Encoder;
};

export function utf8Bytes(text: string): Uint8Array {
  if (!g.TextEncoder) throw new Error("TextEncoder is unavailable in this runtime");
  return new g.TextEncoder().encode(text);
}

/** Lowercase hex SHA-256 of the UTF-8 encoding of `text` (no normalization). */
export async function sha256Hex(
  text: string,
  subtle: Digester | undefined = g.crypto?.subtle,
): Promise<string> {
  if (!subtle) throw new Error("WebCrypto is unavailable in this runtime");
  const digest = new Uint8Array(await subtle.digest("SHA-256", utf8Bytes(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
