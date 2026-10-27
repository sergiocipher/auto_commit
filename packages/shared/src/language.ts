export class UnsupportedLanguageError extends Error {
  override name = "UnsupportedLanguageError";
  constructor(readonly language: string) {
    super(`Unsupported language "${language}". Add a file-extension override for it in settings.`);
  }
}

export interface LanguageInfo {
  /** Stable identifier, e.g. "cpp". "custom" when only a user override matched. */
  normalized: string;
  /** Human-readable name for commit messages, e.g. "C++". */
  display: string;
  /** File extension without the dot, e.g. "cpp". */
  extension: string;
}

interface LanguageDef {
  display: string;
  extension: string;
}

const LANGUAGES: Record<string, LanguageDef> = {
  c: { display: "C", extension: "c" },
  cpp: { display: "C++", extension: "cpp" },
  java: { display: "Java", extension: "java" },
  python: { display: "Python", extension: "py" },
  javascript: { display: "JavaScript", extension: "js" },
  typescript: { display: "TypeScript", extension: "ts" },
  go: { display: "Go", extension: "go" },
  rust: { display: "Rust", extension: "rs" },
  csharp: { display: "C#", extension: "cs" },
  kotlin: { display: "Kotlin", extension: "kt" },
  php: { display: "PHP", extension: "php" },
  ruby: { display: "Ruby", extension: "rb" },
  swift: { display: "Swift", extension: "swift" },
  scala: { display: "Scala", extension: "scala" },
  haskell: { display: "Haskell", extension: "hs" },
  dart: { display: "Dart", extension: "dart" },
  pascal: { display: "Pascal", extension: "pas" },
  sql: { display: "SQL", extension: "sql" },
  bash: { display: "Bash", extension: "sh" },
};

// Ordered: earlier rules win. TypeScript/JavaScript precede Java, Kotlin
// precedes Java, and C++/C# precede plain C so substrings can't misfire.
const RULES: ReadonlyArray<readonly [RegExp, keyof typeof LANGUAGES]> = [
  [/typescript|^ts$/, "typescript"],
  [/javascript|node\.?js|^js\b/, "javascript"],
  [/kotlin/, "kotlin"],
  [/java/, "java"],
  [/c\+\+|g\+\+|cpp/, "cpp"],
  [/c#|csharp|\bmono\b/, "csharp"],
  [/py(?:py|th)/, "python"],
  [/golang|^go\b/, "go"],
  [/rust/, "rust"],
  [/php/, "php"],
  [/ruby/, "ruby"],
  [/swift/, "swift"],
  [/scala/, "scala"],
  [/haskell|\bghc\b/, "haskell"],
  [/dart/, "dart"],
  [/pascal|delphi|\bfpc\b/, "pascal"],
  [/sql/, "sql"],
  [/^bash$|^shell$/, "bash"],
  [/^c$|^c\s?\d{2}\b|\bgcc\b|\bgnu c\d|^ansi c\b|^clang c?\d*$/, "c"],
];

export function overrideKey(language: string): string {
  return language.trim().toLowerCase();
}

function matchRule(lower: string): string | undefined {
  for (const [re, normalized] of RULES) {
    if (re.test(lower)) return normalized;
  }
  return undefined;
}

/**
 * Resolves a raw platform language string ("GNU G++20 13.2 (64 bit, winlibs)",
 * "python3", "PYTH 3") to its normalized id, display name and extension.
 * User overrides (keyed by lowercased raw string) win over built-in rules.
 * Throws UnsupportedLanguageError rather than falling back to `.txt`.
 */
export function resolveLanguage(
  language: string,
  overrides: Record<string, string> = {},
): LanguageInfo {
  const lower = overrideKey(language);
  const normalized = matchRule(lower);
  const def = normalized ? LANGUAGES[normalized] : undefined;
  const override = overrides[lower];
  if (override !== undefined) {
    return {
      normalized: normalized ?? "custom",
      display: def?.display ?? language.trim(),
      extension: override,
    };
  }
  if (!normalized || !def) throw new UnsupportedLanguageError(language);
  return { normalized, display: def.display, extension: def.extension };
}
