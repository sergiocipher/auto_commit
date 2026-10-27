import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Loads a JSON fixture byte-for-byte (no transformation of string contents). */
export function fixture(platform: string, name: string): unknown {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures", platform, name), "utf8"));
}
