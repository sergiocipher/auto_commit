import { utf8Bytes } from "@cst/shared";

interface Digester {
  digest(algorithm: "SHA-1", data: Uint8Array): Promise<ArrayBuffer>;
}
const g = globalThis as unknown as {
  crypto?: { subtle?: Digester };
  atob?: (b64: string) => string;
  TextDecoder?: new (label: string, opts: { fatal: boolean }) => { decode(b: Uint8Array): string };
};

export function decodeBase64Utf8(b64: string): string {
  if (!g.atob || !g.TextDecoder)
    throw new Error("base64/UTF-8 decoding is unavailable in this runtime");
  const binary = g.atob(b64.replace(/\s+/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new g.TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Git's blob object id: sha1("blob <byteLength>\0" + bytes). */
export async function gitBlobSha(content: string): Promise<string> {
  const subtle = g.crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto is unavailable in this runtime");
  const body = utf8Bytes(content);
  const header = utf8Bytes(`blob ${body.length}\0`);
  const all = new Uint8Array(header.length + body.length);
  all.set(header, 0);
  all.set(body, header.length);
  const digest = new Uint8Array(await subtle.digest("SHA-1", all));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
