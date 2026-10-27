import { describe, expect, it } from "vitest";
import { resolveLanguage, UnsupportedLanguageError } from "../src/index.js";

describe("resolveLanguage", () => {
  it.each([
    // LeetCode
    ["cpp", "cpp", "C++", "cpp"],
    ["python3", "python", "Python", "py"],
    ["python", "python", "Python", "py"],
    ["java", "java", "Java", "java"],
    ["javascript", "javascript", "JavaScript", "js"],
    ["typescript", "typescript", "TypeScript", "ts"],
    ["golang", "go", "Go", "go"],
    ["rust", "rust", "Rust", "rs"],
    ["csharp", "csharp", "C#", "cs"],
    ["kotlin", "kotlin", "Kotlin", "kt"],
    ["php", "php", "PHP", "php"],
    ["ruby", "ruby", "Ruby", "rb"],
    ["c", "c", "C", "c"],
    ["mysql", "sql", "SQL", "sql"],
    // Codeforces
    ["GNU G++20 13.2 (64 bit, winlibs)", "cpp", "C++", "cpp"],
    ["GNU G++17 7.3.0", "cpp", "C++", "cpp"],
    ["Clang++20 Diagnostics", "cpp", "C++", "cpp"],
    ["MS C++ 2017", "cpp", "C++", "cpp"],
    ["C++17 (GCC 7-32)", "cpp", "C++", "cpp"],
    ["GNU GCC C11 5.1.0", "c", "C", "c"],
    ["Python 3", "python", "Python", "py"],
    ["PyPy 3-64", "python", "Python", "py"],
    ["Java 21", "java", "Java", "java"],
    ["Kotlin 1.9", "kotlin", "Kotlin", "kt"],
    ["C# 10", "csharp", "C#", "cs"],
    ["Rust 2021", "rust", "Rust", "rs"],
    ["Go", "go", "Go", "go"],
    ["Node.js 15.8.0 (64bit)", "javascript", "JavaScript", "js"],
    ["JavaScript V8 4.8.0", "javascript", "JavaScript", "js"],
    ["Haskell GHC 8.10.1", "haskell", "Haskell", "hs"],
    ["Free Pascal 3.2.2", "pascal", "Pascal", "pas"],
    // CodeChef
    ["C++17", "cpp", "C++", "cpp"],
    ["CPP14", "cpp", "C++", "cpp"],
    ["PYTH 3", "python", "Python", "py"],
    ["PYPY3", "python", "Python", "py"],
    ["JAVA", "java", "Java", "java"],
    ["NODEJS", "javascript", "JavaScript", "js"],
    ["C", "c", "C", "c"],
  ])("%j", (raw, normalized, display, extension) => {
    expect(resolveLanguage(raw)).toEqual({ normalized, display, extension });
  });

  it("throws a clear error for unknown languages instead of using .txt", () => {
    expect(() => resolveLanguage("Befunge-98")).toThrow(UnsupportedLanguageError);
    expect(() => resolveLanguage("Befunge-98")).toThrow(/override/);
  });

  it("applies user overrides by lowercased raw name", () => {
    expect(resolveLanguage("Befunge-98", { "befunge-98": "bf" })).toEqual({
      normalized: "custom",
      display: "Befunge-98",
      extension: "bf",
    });
    expect(resolveLanguage("GNU G++17 7.3.0", { "gnu g++17 7.3.0": "cc" }).extension).toBe("cc");
  });
});
