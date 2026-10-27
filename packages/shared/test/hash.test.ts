import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/index.js";

describe("sha256Hex", () => {
  it("matches the FIPS 180-2 test vector", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is sensitive to every byte (CRLF, tabs, trailing spaces, unicode)", async () => {
    const variants = ["a\nb", "a\r\nb", "a\tb", "a b ", "a b", "café", "café"];
    const hashes = await Promise.all(variants.map((v) => sha256Hex(v)));
    expect(new Set(hashes).size).toBe(variants.length);
  });
});
