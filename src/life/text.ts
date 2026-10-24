// Name matching for wakes (Living cast spec §4.1 `name`, §6.5 watch words), kept from the retired
// memory subjects module.

/** NFKC, trimmed, lower-cased, whitespace collapsed. */
export function normalizeName(name: string): string {
  return name.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

/** True when `name` occurs in `text` as a whole word (any occurrence for CJK names); NFKC, case-folded. */
export function wordBoundaryIncludes(text: string, name: string): boolean {
  const normalizedName = normalizeName(name);
  if (normalizedName.length < 2) return false;
  const haystack = normalizeName(text);
  let index = haystack.indexOf(normalizedName);
  while (index >= 0) {
    const before = index === 0 ? "" : haystack[index - 1]!;
    const after = haystack[index + normalizedName.length] ?? "";
    const isWordChar = (ch: string) => /[\p{L}\p{N}]/u.test(ch);
    // CJK names have no word boundaries; accept any occurrence.
    const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(normalizedName);
    if (cjk || ((!before || !isWordChar(before)) && (!after || !isWordChar(after)))) return true;
    index = haystack.indexOf(normalizedName, index + 1);
  }
  return false;
}
