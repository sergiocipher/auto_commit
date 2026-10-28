/** Settings text format for language overrides: one `language = ext` per line. */
export function formatOverrides(overrides: Record<string, string>): string {
  return Object.entries(overrides)
    .map(([lang, ext]) => `${lang} = ${ext}`)
    .join("\n");
}

export type ParsedOverrides =
  { ok: true; overrides: Record<string, string> } | { ok: false; error: string };

/**
 * Parses override lines. Keys are the platform's language name as shown on
 * the site (matched case-insensitively); values are extensions without the dot.
 */
export function parseOverrides(text: string): ParsedOverrides {
  const overrides: Record<string, string> = {};
  const lines = text.split("\n");
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.lastIndexOf("=");
    const lang = eq === -1 ? "" : line.slice(0, eq).trim().toLowerCase();
    const ext =
      eq === -1
        ? ""
        : line
            .slice(eq + 1)
            .trim()
            .replace(/^\./, "")
            .toLowerCase();
    if (!lang || lang.length > 100)
      return { ok: false, error: `Line ${i + 1}: expected "language = extension".` };
    if (!/^[a-z0-9]{1,10}$/.test(ext))
      return { ok: false, error: `Line ${i + 1}: extension must be 1-10 letters or digits.` };
    overrides[lang] = ext;
  }
  return { ok: true, overrides };
}
