// Name matching for wakes (Living cast spec §4.1 `name`, §6.5 watch words) and forget (§7.4–§7.5),
// kept from the retired memory subjects module.

/** NFKC, trimmed, lower-cased, whitespace collapsed. */
export function normalizeName(name: string): string {
  return name.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Letters that carry a stroke or are ligatures: no Unicode decomposition, so folded by hand. */
const LETTER_FOLDS: Readonly<Record<string, string>> = {
  "ø": "o", "ł": "l", "đ": "d", "ð": "d", "ħ": "h", "ŧ": "t", "ı": "i", "æ": "ae", "œ": "oe", "ß": "ss", "þ": "th"
};
const LETTER_FOLD_PATTERN = /[øłđðħŧıæœßþ]/gu;

/**
 * `normalizeName` with Latin diacritics folded away (José → jose, Søren → soren, Straße → strasse);
 * other scripts' marks stay.
 */
export function foldName(name: string): string {
  return normalizeName(name.normalize("NFKD").replace(/[̀-ͯ]/gu, "").normalize("NFC"))
    .replace(LETTER_FOLD_PATTERN, (letter) => LETTER_FOLDS[letter] ?? letter);
}

/** `wordBoundaryIncludes` with diacritics folded on both sides: "jose" finds José and "José" finds Jose. */
export function namesSomeone(text: string, name: string): boolean {
  return wordBoundaryIncludes(foldName(text), foldName(name));
}

/**
 * Words too generic to stand for one person (forget lists matches for review, never removes them):
 * pronouns, roles, kin and pet names, and common chat and server words.
 */
const GENERIC_NAMES = new Set([
  "admin", "administrator", "all", "anon", "anonymous", "anybody", "anyone", "aunt", "babe", "baby", "best", "bestie", "big", "boss",
  "bot", "boy", "boyfriend", "bro", "brother", "buddy", "bye", "channel", "chat", "child", "cool", "cousin", "crush", "dad", "darling",
  "daughter", "dear", "deleted user", "discord", "dude", "everybody", "everyone", "family", "father", "friend", "friends", "game",
  "general", "girl", "girlfriend", "good", "grandma", "grandpa", "great", "group", "guest", "guys", "haha", "hello", "help", "her",
  "here", "hey", "him", "home", "honey", "human", "husband", "kid", "lmao", "lol", "love", "man", "mate", "maybe", "me", "member",
  "message", "mister", "mod", "moderator", "mods", "mom", "morning", "mother", "music", "new", "nice", "night", "no one", "nobody",
  "noone", "okay", "old", "owner", "pal", "partner", "people", "person", "player", "please", "real", "really", "school", "server",
  "sir", "sis", "sister", "somebody", "someone", "son", "sorry", "staff", "support", "sweetie", "team", "test", "thank you", "thanks",
  "that", "the", "them", "there", "they", "this", "today", "tomorrow", "tonight", "uncle", "unknown", "user", "users", "welcome",
  "what", "wife", "woman", "work", "yeah", "yes", "yesterday", "you"
]);

/** Generic words (above) never stand for a person. */
export function isGenericName(name: string): boolean {
  return GENERIC_NAMES.has(foldName(name));
}

/** Scripts written without spaces between words (or, for Hangul, with particles attached). */
const NO_WORD_BOUNDARIES =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/**
 * A name in a script without word boundaries matches anywhere (はな inside はなし), so a match is
 * never proof it means the person: forget lists such matches for review outside the person's own
 * notes (spec §7.4).
 */
export function hasNoWordBoundaries(name: string): boolean {
  return NO_WORD_BOUNDARIES.test(name);
}

/**
 * A name too short or too generic to remove text by: three characters or fewer (one for CJK names,
 * which are often two or three characters long), or a generic word.
 */
export function isWeakName(name: string): boolean {
  const folded = foldName(name);
  return [...folded].length <= (hasNoWordBoundaries(folded) ? 1 : 3) || GENERIC_NAMES.has(folded);
}

/** True when `name` occurs in `text` as a whole word (any occurrence for CJK names); NFKC, case-folded. */
export function wordBoundaryIncludes(text: string, name: string): boolean {
  const normalizedName = normalizeName(name);
  if (normalizedName.length < 2) return false;
  const haystack = normalizeName(text);
  // Names without word boundaries: any occurrence.
  const anywhere = hasNoWordBoundaries(normalizedName);
  let index = haystack.indexOf(normalizedName);
  while (index >= 0) {
    const before = index === 0 ? "" : haystack[index - 1]!;
    const after = haystack[index + normalizedName.length] ?? "";
    const isWordChar = (ch: string) => /[\p{L}\p{N}]/u.test(ch);
    if (anywhere || ((!before || !isWordChar(before)) && (!after || !isWordChar(after)))) return true;
    index = haystack.indexOf(normalizedName, index + 1);
  }
  return false;
}

/**
 * Forget's matcher for in-memory traffic (the captured query log, the `/api/events` replay): an
 * entry carries the person when it holds their id or a name only they have. Weak names never
 * match, so other people's entries stay.
 */
export function personMatcher(userId: string, names: readonly string[] = []): (text: string) => boolean {
  const strong = [...new Set(names)].filter((name) => !isWeakName(name));
  return (text) => text.includes(userId) || strong.some((name) => namesSomeone(text, name));
}
