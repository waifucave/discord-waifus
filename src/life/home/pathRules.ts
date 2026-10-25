// Her machine's path rules (Living cast spec §16.2): one module, used by every tool, the Bash
// change set, the API and the dashboard. She sees two folders and nothing else:
//
//   /home/<slug>/   her home and working directory (`~`), backed by user/waifus/<id>/home/
//   /tmp/           downloads and scratch files, backed by user/waifus/<id>/tmp/
//
// A path is absolute (`/home/aria/people/kevin.md`, `/tmp/x.png`), `~`-based, or relative to her
// home. After normalising (`.` and `..` resolved) it must stay inside one of the two folders. Each
// segment is 1–100 characters, without control characters, `\` or NUL, never `.`/`..` and never a
// Windows device name (`con`, `prn`, `aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`, with or without an
// extension); at most 8 segments below the folder. Host paths never appear in anything she sees.

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

/** Her special files at the top of her home (§16.2). */
export const PLACES_FILE = "places.md";
export const SCHEDULE_FILE = "schedule.json";
export const WATCHES_FILE = "watches.json";
export const MEMORY_FILE = "MEMORY.md";

/** Names Windows reserves for devices (`con.md` would open the console, not a file). */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/iu;
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
  if (WINDOWS_DEVICE.test(segment)) return `${segment} is a reserved name; pick another`;
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

/** True for `~/places.md` (read-only, kept up to date by the app). */
export function isPlacesFile(p: Pick<HerPath, "root" | "segments">): boolean {
  return p.root === "home" && p.segments.length === 1 && p.segments[0] === PLACES_FILE;
}

/** `~/schedule.json` or `~/watches.json`: checked on every write (§16.4, §16.5). */
export function specialJsonFile(p: Pick<HerPath, "root" | "segments">): "schedule" | "watches" | undefined {
  if (p.root !== "home" || p.segments.length !== 1) return undefined;
  if (p.segments[0] === SCHEDULE_FILE) return "schedule";
  if (p.segments[0] === WATCHES_FILE) return "watches";
  return undefined;
}

/** A virtual path string (`/home/aria/x`, `/tmp/x`) back to a checked path; undefined outside her folders. */
export function parseVirtual(virtual: string, slug: string): HerPath | undefined {
  const resolved = resolveHerPath(virtual, slug, { allowRoot: true });
  return resolved.ok && resolved.path.virtual === path.posix.normalize(virtual).replace(/\/+$/u, "") ? resolved.path : undefined;
}

/** A file name made safe for one segment (downloads): separators and control characters replaced, length cut. */
export function safeFileName(name: string, fallback = "file"): string {
  // eslint-disable-next-line no-control-regex
  let cleaned = name.replace(/[\u0000-\u001f\u007f/\\]/gu, "_").replace(/^\.+/u, "").trim();
  if (!cleaned) cleaned = fallback;
  if (WINDOWS_DEVICE.test(cleaned)) cleaned = `_${cleaned}`;
  const chars = [...cleaned];
  if (chars.length > MAX_SEGMENT_CHARS) {
    const dot = cleaned.lastIndexOf(".");
    const ext = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : "";
    cleaned = chars.slice(0, MAX_SEGMENT_CHARS - [...ext].length).join("") + ext;
  }
  return cleaned;
}
