// Name matching for wakes (Living cast spec §4.1 `name`, §6.5 watch words), kept from the retired
// memory subjects module.

/** NFKC, trimmed, lower-cased, whitespace collapsed. */
export function normalizeName(name: string): string {
  return name.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

/** `normalizeName` with Latin diacritics folded away (José → jose); other scripts' marks stay. */
export function foldName(name: string): string {
  return normalizeName(name.normalize("NFKD").replace(/[̀-ͯ]/gu, "").normalize("NFC"));
}

/** `wordBoundaryIncludes` with diacritics folded on both sides: "jose" finds José and "José" finds Jose. */
export function namesSomeone(text: string, name: string): boolean {
  return wordBoundaryIncludes(foldName(text), foldName(name));
}

/** Words too generic to stand for one person (forget lists matches for review, never removes them). */
const GENERIC_NAMES = new Set([
  "admin", "administrator", "anyone", "babe", "baby", "boss", "bot", "bro", "dad", "dear", "deleted user", "dude", "everyone", "friend",
  "guest", "her", "here", "hey", "hello", "him", "love", "me", "member", "mod", "moderator", "mods", "mom", "owner", "people", "person",
  "sis", "someone", "test", "them", "unknown", "user", "users", "you"
]);

/** Generic words (above) never stand for a person. */
export function isGenericName(name: string): boolean {
  return GENERIC_NAMES.has(foldName(name));
}

/**
 * A name too short or too generic to remove text by: three characters or fewer (one for CJK names,
 * which are often two or three characters long), or a generic word.
 */
export function isWeakName(name: string): boolean {
  const folded = foldName(name);
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(folded);
  return [...folded].length <= (cjk ? 1 : 3) || GENERIC_NAMES.has(folded);
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
