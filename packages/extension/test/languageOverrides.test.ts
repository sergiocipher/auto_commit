import { describe, expect, it } from "vitest";
import { resolveLanguage, SettingsSchema, DEFAULT_SETTINGS } from "@cst/shared";
import { formatOverrides, parseOverrides } from "../src/ui/languageOverrides.js";

describe("language override text", () => {
  it("parses lines into lowercased keys the language resolver uses", () => {
    const r = parseOverrides("  My Lang 2.0 = .MYL \n\n# comment\nZig = zig\n");
    expect(r).toEqual({ ok: true, overrides: { "my lang 2.0": "myl", zig: "zig" } });
    if (!r.ok) return;
    expect(resolveLanguage("My Lang 2.0", r.overrides).extension).toBe("myl");
    expect(
      SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, languageExtensionOverrides: r.overrides })
        .success,
    ).toBe(true);
  });

  it("keeps '=' inside language names", () => {
    expect(parseOverrides("a=b = c")).toEqual({ ok: true, overrides: { "a=b": "c" } });
  });

  it("reports the bad line", () => {
    expect(parseOverrides("ok = c\nno separator")).toEqual({
      ok: false,
      error: 'Line 2: expected "language = extension".',
    });
    expect(parseOverrides("x = ../evil")).toMatchObject({ ok: false, error: /Line 1: extension/ });
    expect(parseOverrides("x = toolongextension")).toMatchObject({ ok: false });
    expect(parseOverrides(" = cpp")).toMatchObject({ ok: false });
  });

  it("round-trips the stored form", () => {
    const overrides = { "gnu g++20": "cpp", zig: "zig" };
    expect(parseOverrides(formatOverrides(overrides))).toEqual({ ok: true, overrides });
    expect(formatOverrides({})).toBe("");
    expect(parseOverrides("")).toEqual({ ok: true, overrides: {} });
  });
});
