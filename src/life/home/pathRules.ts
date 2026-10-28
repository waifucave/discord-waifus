// Her machine's path rules (Living cast spec §16.2, §21): one module, used by every tool, the Bash
// change set, the API and the dashboard. She sees two folders and nothing else:
//
//   /home/<slug>/   her home and working directory (`~`), backed by user/waifus/<id>/home/
//   /tmp/           downloads and scratch files, backed by user/waifus/<id>/tmp/
//
// A path is absolute (`/home/aria/people/kevin.md`, `/tmp/x.png`), `~`-based, or relative to her
// home. After normalising (`.` and `..` resolved) it must stay inside one of the two folders. Each
// segment is 1–100 characters, without control characters, `\` or NUL, never `.`/`..`, never ending
// in a dot or a space, and never a Windows device name (`con`, `prn`, `aux`, `nul`, `com1`–`com9`,
// `lpt1`–`lpt9`, also with superscript digits, with or without an extension, trailing dots or
// spaces); at most 8 segments below the folder. Names are compared by `collisionKey` (case and
// Unicode normalisation) wherever a special or private name is recognised, because her disk may be
// case-insensitive. Host paths never appear in anything she sees.

import path from "node:path";
import { slugify } from "../places.js";

export type HerRoot = "home" | "tmp";

/** A checked path on her machine. `segments` are below the root (empty for the root itself). */
export type HerPath = {
  root: HerRoot;
  segments: string[];
  /** `/home/aria/people/kevin.md`, `/tmp/x.png`. */
  virtual: string;
  /** `~/people/kevin.md`, `/tmp/x.png` (how results name it). */
  display: string;
};

export const MAX_PATH_SEGMENTS = 8;
export const MAX_SEGMENT_CHARS = 100;

/** Her notes index, at the top of her home with her notes (§16.2, §21 S1). */
export const MEMORY_FILE = "MEMORY.md";
/** `~/life/`: her daily machinery, the app-managed files (§21 S1). */
export const LIFE_DIR = "life";
/** `~/life/places.md`: read-only, kept up to date by the app (§16.6). */
export const PLACES_FILE = "places.md";
/** `~/life/schedule.json`: her day, which she writes each morning (§21.2). */
export const DAY_SCHEDULE_FILE = "schedule.json";
/** `~/life/wakeups.json`: every wakeup she has (Wakeup, §30.3; `reminders.json` and `watches.json` before). */
export const WAKEUPS_FILE = "wakeups.json";
/** `~/life/profile.json`: her Discord profile (§17.1): checked on every write, then becomes her config. */
export const PROFILE_FILE = "profile.json";
/** Every file the app keeps in `~/life/`. */
export const LIFE_FILES = [DAY_SCHEDULE_FILE, WAKEUPS_FILE, PROFILE_FILE, PLACES_FILE] as const;
export type LifeFileName = (typeof LIFE_FILES)[number];

/** Names Windows reserves for devices (`con.md` would open the console, not a file). */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/iu;

/** A Windows device name in any spelling Windows treats as one (`COM¹`, `aux.`, `con .txt`). */
function isDeviceName(segment: string): boolean {
  const folded = segment.normalize("NFKC").replace(/[. ]+$/u, "");
  const stem = folded.split(".")[0]!.replace(/ +$/u, "");
  return WINDOWS_DEVICE.test(folded) || WINDOWS_DEVICE.test(stem);
}
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/u;

/** Her folder's name: her name, lower-case and ASCII-folded (`aria`); `me` when nothing is left. */
export function herSlug(waifu: { name: string }): string {
  return slugify(waifu.name) || "me";
}

/** Why one segment is refused, or undefined when it is fine. */
export function segmentProblem(segment: string): string | undefined {
  if (segment.length === 0) return "empty path segment";
  if (segment === "." || segment === "..") return "\"..\" can't leave your folders";
  if ([...segment].length > MAX_SEGMENT_CHARS) return `a name can be at most ${MAX_SEGMENT_CHARS} characters`;
  if (segment.includes("\\")) return "names can't contain \\";
  if (CONTROL.test(segment)) return "names can't contain control characters";
  if (isDeviceName(segment)) return `${segment} is a reserved name; pick another`;
  if (/[. ]$/u.test(segment)) return "names can't end with a dot or a space";
  return undefined;
}

/** The key two names in one folder collide on (case-insensitive disks, Unicode normalisation). */
export function collisionKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

export function herPath(root: HerRoot, segments: readonly string[], slug: string): HerPath {
  const rel = segments.join("/");
  const virtual = root === "home" ? `/home/${slug}${rel ? `/${rel}` : ""}` : `/tmp${rel ? `/${rel}` : ""}`;
  const display = root === "home" ? (rel ? `~/${rel}` : "~") : virtual;
  return { root, segments: [...segments], virtual, display };
}

export type ResolvedHerPath = { ok: true; path: HerPath } | { ok: false; error: string };

/**
 * A path as she (or the owner) wrote it → her path. `allowRoot`: the folder itself (`~`, `/tmp`) is
 * accepted (listing); files need at least one segment.
 */
export function resolveHerPath(input: unknown, slug: string, o: { allowRoot?: boolean } = {}): ResolvedHerPath {
  if (typeof input !== "string" || input.trim().length === 0) return { ok: false, error: "a path is required" };
  const raw = input.trim();
  if (raw.includes("\0")) return { ok: false, error: "paths can't contain NUL" };
  if (raw.includes("\\")) return { ok: false, error: "use / in paths, not \\" };
  if (raw.length > 2000) return { ok: false, error: "path too long" };
  let absolute: string;
  if (raw === "~") absolute = `/home/${slug}`;
  else if (raw.startsWith("~/")) absolute = `/home/${slug}/${raw.slice(2)}`;
  else if (raw.startsWith("/")) absolute = raw;
  else absolute = `/home/${slug}/${raw}`;
  // Every segment as written is checked first (a `..` that stays inside is resolved below).
  for (const segment of absolute.split("/")) {
    if (segment === "" || segment === "." || segment === "..") continue;
    const problem = segmentProblem(segment);
    if (problem) return { ok: false, error: problem };
  }
  const normalized = path.posix.normalize(absolute).replace(/\/+$/u, "") || "/";
  const homePrefix = `/home/${slug}`;
  let root: HerRoot;
  let rest: string;
  if (normalized === homePrefix || normalized.startsWith(`${homePrefix}/`)) {
    root = "home";
    rest = normalized.slice(homePrefix.length);
  } else if (normalized === "/tmp" || normalized.startsWith("/tmp/")) {
    root = "tmp";
    rest = normalized.slice("/tmp".length);
  } else {
    return { ok: false, error: `${raw} is outside your folders (your home ~ and /tmp)` };
  }
  const segments = rest.split("/").filter(Boolean);
  if (segments.length === 0 && !o.allowRoot) return { ok: false, error: `${raw} is a folder, not a file` };
  if (segments.length > MAX_PATH_SEGMENTS) return { ok: false, error: `paths can be at most ${MAX_PATH_SEGMENTS} folders deep` };
  for (const segment of segments) {
    const problem = segmentProblem(segment);
    if (problem) return { ok: false, error: problem };
  }
  return { ok: true, path: herPath(root, segments, slug) };
}

/** True for anything in `~/life/` (the folder itself included): her daily machinery (§21). */
export function isLifeDirPath(p: Pick<HerPath, "root" | "segments">): boolean {
  return p.root === "home" && p.segments.length > 0 && collisionKey(p.segments[0]!) === LIFE_DIR;
}

/** Which of her `~/life/` files a path is, in any spelling (`~/Life/Places.MD` is places.md). */
export function lifeFileOf(p: Pick<HerPath, "root" | "segments">): LifeFileName | undefined {
  if (p.segments.length !== 2 || !isLifeDirPath(p)) return undefined;
  const key = collisionKey(p.segments[1]!);
  return LIFE_FILES.find((name) => collisionKey(name) === key);
}

/** The segments of one of her `~/life/` files (`["life", "wakeups.json"]`). */
export function lifeSegments(name: LifeFileName): string[] {
  return [LIFE_DIR, name];
}

/** `~/life/<name>` as her results name it. */
export function lifeDisplay(name: LifeFileName): string {
  return `~/${LIFE_DIR}/${name}`;
}

/** True for `~/life/places.md` (read-only, kept up to date by the app). */
export function isPlacesFile(p: Pick<HerPath, "root" | "segments">): boolean {
  return lifeFileOf(p) === PLACES_FILE;
}

/** A delete of this path would remove places.md (the file itself, or `~/life`). */
export function deleteReachesPlaces(p: Pick<HerPath, "root" | "segments">): boolean {
  return p.root === "home" && ((p.segments.length === 1 && isLifeDirPath(p)) || isPlacesFile(p));
}

/** True for `/tmp/dm/…` in any spelling (a private chat's downloads, D14). */
export function isDmFolderPath(p: Pick<HerPath, "root" | "segments">): boolean {
  return p.root === "tmp" && p.segments.length > 0 && collisionKey(p.segments[0]!) === "dm";
}

/** Same name on a case-insensitive disk. */
export function sameName(a: string, b: string): boolean {
  return collisionKey(a) === collisionKey(b);
}

/** The key of a whole virtual path (`/home/aria/People/Kevin.md` and `/home/aria/people/kevin.md` share it). */
export function pathKey(virtual: string): string {
  return collisionKey(virtual);
}

/** The special file kinds, checked on every write (§30.3, §17.1, §21.2). */
export type SpecialKind = "wakeups" | "profile" | "schedule";

/** `~/life/wakeups.json`, `profile.json` or `schedule.json` (her day, §21.2): checked on every write. */
export function specialJsonFile(p: Pick<HerPath, "root" | "segments">): SpecialKind | undefined {
  const name = lifeFileOf(p);
  if (name === WAKEUPS_FILE) return "wakeups";
  if (name === PROFILE_FILE) return "profile";
  if (name === DAY_SCHEDULE_FILE) return "schedule";
  return undefined;
}

/** A special kind's file name in `~/life/`. */
export function specialFileName(kind: SpecialKind): LifeFileName {
  return kind === "wakeups" ? WAKEUPS_FILE : kind === "profile" ? PROFILE_FILE : DAY_SCHEDULE_FILE;
}

/**
 * Her special files' canonical spelling (a write to `~/Life/Wakeups.json` lands in
 * `~/life/wakeups.json`, one to `~/memory.md` in `~/MEMORY.md`): the segments to use, or undefined.
 */
export function canonicalSpecialSegments(p: Pick<HerPath, "root" | "segments">): string[] | undefined {
  if (p.root !== "home") return undefined;
  if (p.segments.length === 1 && collisionKey(p.segments[0]!) === collisionKey(MEMORY_FILE)) return [MEMORY_FILE];
  const name = lifeFileOf(p);
  return name ? lifeSegments(name) : undefined;
}

/** True for `~/MEMORY.md` (any spelling). */
export function isMemoryFile(p: Pick<HerPath, "root" | "segments">): boolean {
  return p.root === "home" && p.segments.length === 1 && collisionKey(p.segments[0]!) === collisionKey(MEMORY_FILE);
}

/** A virtual path string (`/home/aria/x`, `/tmp/x`) back to a checked path; undefined outside her folders. */
export function parseVirtual(virtual: string, slug: string): HerPath | undefined {
  const resolved = resolveHerPath(virtual, slug, { allowRoot: true });
  return resolved.ok && resolved.path.virtual === path.posix.normalize(virtual).replace(/\/+$/u, "") ? resolved.path : undefined;
}

/** A file name made safe for one segment (downloads): separators and control characters replaced, length cut. */
export function safeFileName(name: string, fallback = "file"): string {
  // eslint-disable-next-line no-control-regex
  let cleaned = name.replace(/[\u0000-\u001f\u007f/\\]/gu, "_").replace(/^\.+/u, "").trim().replace(/[. ]+$/u, "");
  if (!cleaned) cleaned = fallback;
  if (isDeviceName(cleaned)) cleaned = `_${cleaned}`;
  const chars = [...cleaned];
  if (chars.length > MAX_SEGMENT_CHARS) {
    const dot = cleaned.lastIndexOf(".");
    const ext = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : "";
    cleaned = chars.slice(0, MAX_SEGMENT_CHARS - [...ext].length).join("") + ext;
  }
  return cleaned;
}
