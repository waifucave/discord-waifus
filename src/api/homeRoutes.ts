// Her own computer over HTTP (Living cast spec §16.11): her files in `/home/<slug>` and `/tmp`, her
// reminders (`~/schedule.json`) and her watches (`~/watches.json`). Every write goes through her
// HomeStore, so the API's PUT and DELETE are held to the same path rules, limits and checks as her
// Write tool (`places.md` refused, the JSON files checked with line and column).
//
// Paths in URLs are her paths without the leading slash: `files/home/aria/people/kevin.md`,
// `files/tmp/bake-club/general/k3-cake.png` (or `files/~/people/kevin.md`). A file answers as JSON
// (text inline for a UTF-8 text file up to 1 MiB); `?raw=1` answers its bytes with their type
// (images and PDFs by their magic bytes, never by name; anything else as an attachment).
//
// DM content (D14): a file from a private chat (a download from a DM, a copy of one by hash, or
// anything under `/tmp/dm/<handle>/`) and a watch bound to a DM are private. Listings keep a private
// entry but leave out its name and path (`[private chat redacted]`); reading, writing or deleting a
// private file, or listing a private folder, needs `includePrivate=1`, which only a local request
// may send (403 `PrivateContentLocalOnly` otherwise, and always for the dashboard assistant).
// Errors never carry host paths: her store's messages name only her paths.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { loadAppConfig } from "../config/appConfig.js";
import { HerFilesError, type HerEntry } from "../life/home/herFiles.js";
import { HomeError, isTextBytes, sha256, type CheckEnv, type HomeStore } from "../life/home/homeStore.js";
import { checkEnvFor, homeStoreFor, offlineCheckEnv } from "../life/home/index.js";
import { isPlacesFile, specialJsonFile, type HerPath, type HerRoot } from "../life/home/pathRules.js";
import { parseStrictJson, type WatchEntry } from "../life/home/specialFiles.js";
import { isDmPlaceKey, isDmPlaceRef } from "../life/lifeView.js";
import type { LivingCast } from "../life/livingCast.js";
import { hostTimeZone } from "../orchestration/context/timeFormat.js";
import { readWaifu } from "../orchestration/stores/config.js";
import { PRIVATE_FILE_NAME } from "../shared/constants/files.js";
import { HER_ROOTS, HerFileWriteBodySchema } from "../shared/schemas/api.js";
import type { FilesIndex, WatchIds } from "../shared/schemas/life.js";
import type { StorageService } from "../storage/storageService.js";
import { ApiError, badRequest, conflict, notFound } from "./errors.js";
import { assertSafeId } from "./ids.js";
import { includePrivateOf } from "./lifeRoutes.js";

export type HomeRouteOptions = {
  storage: StorageService;
  /** The live Living cast (absent while Discord is offline): its clock and the people she knows. */
  cast: () => LivingCast | undefined;
  now?: () => Date;
  timeZone?: string;
};

/** A text file's text is inlined up to this size; larger ones are fetched with `?raw=1`. */
export const TEXT_INLINE_MAX_BYTES = 1024 * 1024;
/** The largest file `?raw=1` answers (downloads are ≤ 10 MiB, her home ≤ 50 MiB). */
export const RAW_MAX_BYTES = 64 * 1024 * 1024;

const ID = /^[a-z][a-z0-9_-]{0,19}$/u;

function waifuIdOf(params: unknown): string {
  const { waifuId } = z.object({ waifuId: z.string().min(1) }).parse(params);
  assertSafeId(waifuId);
  return waifuId;
}

function privateRefused(): ApiError {
  return new ApiError(
    403,
    "This came from a private chat (D14): reveal DM content with includePrivate=1, on the host itself only.",
    undefined,
    "PrivateContentLocalOnly"
  );
}

/** Her store's model-facing message without its `error: ` prefix. */
function plain(message: string): string {
  return message.replace(/^error:\s*/u, "");
}

/** HomeError / HerFilesError → an API error with her store's own message (never a host path). */
function apiErrorOf(error: unknown): unknown {
  if (error instanceof HomeError) {
    const message = plain(error.message);
    switch (error.code) {
      case "conflict":
        return conflict(message);
      case "missing":
        return notFound(message);
      case "limit":
        return new ApiError(413, message, undefined, "HomeLimit");
      case "places":
        return new ApiError(400, message, undefined, "ReadOnlyFile");
      case "special":
        return new ApiError(400, message, undefined, "InvalidFile");
      case "binary":
        return new ApiError(400, message, undefined, "NotTextFile");
      case "collision":
        return new ApiError(409, message, undefined, "NameCollision");
      case "link":
        return new ApiError(400, message, undefined, "LinkRefused");
      default:
        return badRequest(message);
    }
  }
  if (error instanceof HerFilesError) {
    const message = plain(error.message);
    if (error.code === "missing") return notFound(message);
    if (error.code === "too_large") return new ApiError(413, message, undefined, "HomeLimit");
    if (error.code === "link") return new ApiError(400, message, undefined, "LinkRefused");
    return badRequest(message);
  }
  return error;
}

async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw apiErrorOf(error);
  }
}

/** A folder under `/tmp/dm/<handle>` (or the handle folder itself) names a private chat. */
function privateFolder(p: Pick<HerPath, "root" | "segments">): boolean {
  return p.root === "tmp" && p.segments[0] === "dm" && p.segments.length >= 2;
}

/** The file's type by its first bytes (never by its name). */
export function sniffKind(data: Uint8Array): { kind: "text" | "image" | "pdf" | "binary"; contentType: string } {
  const starts = (...bytes: number[]) => bytes.every((byte, index) => data[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { kind: "image", contentType: "image/png" };
  if (starts(0xff, 0xd8, 0xff)) return { kind: "image", contentType: "image/jpeg" };
  if (starts(0x47, 0x49, 0x46, 0x38)) return { kind: "image", contentType: "image/gif" };
  if (starts(0x52, 0x49, 0x46, 0x46) && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return { kind: "image", contentType: "image/webp" };
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return { kind: "pdf", contentType: "application/pdf" };
  if (isTextBytes(data)) return { kind: "text", contentType: "text/plain; charset=utf-8" };
  return { kind: "binary", contentType: "application/octet-stream" };
}

function iso(mtimeMs: number): string {
  return new Date(Math.max(0, Math.round(mtimeMs))).toISOString();
}

/** A watch bound to a private chat (D14): a binding resolved to a DM place, or one that names one. */
export function isPrivateWatch(entry: WatchEntry, ids: WatchIds): boolean {
  const resolved = ids.watches[entry.id]?.bindings ?? [];
  return resolved.some((binding) => isDmPlaceKey(binding.placeKey)) || entry.when.some((binding) => isDmPlaceRef(binding.place));
}

/** A watch as the owner sees it: a private one keeps its id, times and shape, never its words. */
export function watchView(entry: WatchEntry, ids: WatchIds, includePrivate: boolean) {
  const isPrivate = isPrivateWatch(entry, ids);
  const hide = isPrivate && !includePrivate;
  return {
    id: entry.id,
    timeout: entry.timeout,
    once: entry.once,
    note: hide ? PRIVATE_FILE_NAME : entry.note,
    when: entry.when.map((binding) =>
      hide
        ? {
            ...(binding.place !== undefined ? { place: PRIVATE_FILE_NAME } : {}),
            ...(binding.from !== undefined ? { from: PRIVATE_FILE_NAME } : {}),
            ...(binding.words !== undefined ? { words: [PRIVATE_FILE_NAME] } : {}),
            ...(binding.any_message !== undefined ? { any_message: binding.any_message } : {})
          }
        : { ...binding }
    ),
    ...(isPrivate ? { private: true as const } : {})
  };
}

/** True when the text is an array the lenient reader read whole (the app's own rewrite rule). */
function readsWhole(text: string | undefined, read: number): boolean {
  if (!text?.trim()) return true;
  try {
    const value = parseStrictJson(text);
    return Array.isArray(value) && value.length === read;
  } catch {
    return false;
  }
}

export function registerHomeRoutes(app: FastifyInstance, o: HomeRouteOptions): void {
  const timeZone = () => o.timeZone ?? o.cast()?.deps.timeZone ?? hostTimeZone();
  const now = () => o.now?.() ?? o.cast()?.deps.now() ?? new Date();

  /** Her store (live config when the cast runs, else config.toml) and the write checks' environment. */
  const homeOf = async (waifuId: string): Promise<{ home: HomeStore; env: () => CheckEnv }> => {
    let waifu;
    try {
      waifu = await readWaifu(o.storage, waifuId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw notFound(`Waifu ${waifuId} was not found.`);
      throw error;
    }
    const cast = o.cast();
    if (cast) return { home: homeStoreFor(cast.deps, waifu), env: () => ({ ...checkEnvFor(cast.deps, waifuId), now: now(), timeZone: timeZone() }) };
    const config = await loadAppConfig(o.storage.dataRoot);
    return { home: homeStoreFor({ storage: o.storage, config: () => config }, waifu), env: () => offlineCheckEnv(o.storage, waifuId, { now: now(), timeZone: timeZone() }) };
  };

  /** The `*` part of a files URL → her path. */
  const filePath = (home: HomeStore, request: FastifyRequest, o2: { allowRoot?: boolean } = {}): HerPath => {
    const raw = String((request.params as Record<string, unknown>)["*"] ?? "");
    const input = raw.startsWith("~") ? raw : `/${raw}`;
    const resolved = home.resolve(input, o2);
    if (!resolved.ok) throw badRequest(resolved.error);
    return resolved.path;
  };

  /** A private file (D14), by its folder or its provenance. */
  const isPrivateFile = async (home: HomeStore, p: HerPath, index?: FilesIndex): Promise<boolean> =>
    (p.root === "tmp" && p.segments[0] === "dm") || (await home.dmOrigin(p, index)) !== undefined;

  /** Assistant writes need the owner's click on the confirmation card (§16.11). */
  const refuseUnconfirmedAssistant = (request: FastifyRequest) => {
    if (request.assistantDelegation && !request.assistantDelegation.pendingActionId) {
      throw new ApiError(403, "The dashboard assistant only proposes file changes; the owner confirms them on a dashboard card.", undefined, "AssistantConfirmationRequired");
    }
  };

  app.get("/api/waifus/:waifuId/files", async (request) => {
    const waifuId = waifuIdOf(request.params);
    const includePrivate = includePrivateOf(request);
    const query = z.object({ root: z.enum(HER_ROOTS).optional(), dir: z.string().max(2000).optional() }).parse(request.query ?? {});
    const { home } = await homeOf(waifuId);
    let folder: HerPath;
    const dir = query.dir?.trim() ?? "";
    if (dir.startsWith("/") || dir.startsWith("~")) {
      const resolved = home.resolve(dir, { allowRoot: true });
      if (!resolved.ok) throw badRequest(resolved.error);
      if (query.root && resolved.path.root !== query.root) throw badRequest(`${dir} is not under ${query.root === "home" ? "her home" : "/tmp"}.`);
      folder = resolved.path;
    } else {
      const root: HerRoot = query.root ?? "home";
      const resolved = home.resolve(dir ? `${root === "home" ? "~" : "/tmp"}/${dir}` : root === "home" ? "~" : "/tmp", { allowRoot: true });
      if (!resolved.ok) throw badRequest(resolved.error);
      folder = resolved.path;
    }
    if (privateFolder(folder) && !includePrivate) throw privateRefused();
    const [entries, usage, index] = await mapped(async () => Promise.all([home.files.list(folder), home.files.usage(folder.root), home.readIndex()]));
    let redacted = 0;
    const views = [];
    const sorted = [...entries].sort((a: HerEntry, b: HerEntry) => (a.kind === b.kind ? a.path.segments.at(-1)!.localeCompare(b.path.segments.at(-1)!) : a.kind === "dir" ? -1 : 1));
    for (const entry of sorted) {
      const isPrivate = entry.kind === "dir" ? privateFolder(entry.path) : await isPrivateFile(home, entry.path, index);
      const hide = isPrivate && !includePrivate;
      if (hide) redacted += 1;
      views.push({
        name: hide ? PRIVATE_FILE_NAME : entry.path.segments.at(-1)!,
        ...(hide ? {} : { path: entry.path.virtual }),
        kind: entry.kind,
        size: entry.size,
        modified: iso(entry.mtimeMs),
        ...(isPrivate ? { private: true as const } : {}),
        ...(hide ? { redacted: true as const } : {})
      });
    }
    const config = o.cast()?.deps.config() ?? (await loadAppConfig(o.storage.dataRoot));
    const parent = folder.segments.length === 0 ? null : home.path(folder.root, folder.segments.slice(0, -1)).virtual;
    return {
      waifuId,
      root: folder.root,
      dir: folder.virtual,
      display: folder.display,
      parent,
      entries: views,
      includePrivate,
      redacted,
      usage:
        folder.root === "home"
          ? { bytes: usage.bytes, files: usage.files, maxBytes: config.life.home.maxBytes, maxFiles: config.life.home.maxFiles }
          : { bytes: usage.bytes, files: usage.files, maxBytes: config.life.tmp.maxBytes }
    };
  });

  app.get("/api/waifus/:waifuId/files/*", async (request, reply: FastifyReply) => {
    const waifuId = waifuIdOf(request.params);
    const includePrivate = includePrivateOf(request);
    const { raw } = z.object({ raw: z.enum(["0", "1", "true", "false"]).optional() }).parse({ raw: (request.query as Record<string, unknown> | undefined)?.["raw"] });
    const { home } = await homeOf(waifuId);
    const p = filePath(home, request);
    const info = await home.files.inspect(p);
    if (info.kind === "missing") throw notFound(`${p.display} doesn't exist`);
    if (info.kind === "link") throw new ApiError(400, `${p.display} can't be used: it is a link`, undefined, "LinkRefused");
    if (info.kind !== "file") throw new ApiError(400, `${p.display} is a folder, not a file (list it with GET /api/waifus/${waifuId}/files?dir=…)`, undefined, "IsFolder");
    const isPrivate = await isPrivateFile(home, p);
    if (isPrivate && !includePrivate) throw privateRefused();
    if (info.size > RAW_MAX_BYTES) throw new ApiError(413, `${p.display} is too large to open here`, undefined, "HomeLimit");
    const data = await mapped(() => home.files.readBytes(p, { maxBytes: RAW_MAX_BYTES }));
    const sniffed = sniffKind(data);
    if (raw === "1" || raw === "true") {
      // Her bytes are untrusted: never rendered as a page on the dashboard's origin.
      const inline = sniffed.kind === "image";
      const name = (p.segments.at(-1) ?? "file").replace(/[^\w.-]+/gu, "_").slice(0, 100) || "file";
      return reply
        .header("content-type", sniffed.contentType)
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'; sandbox")
        .header("content-disposition", `${inline ? "inline" : "attachment"}; filename="${name}"`)
        .send(data);
    }
    const tooLarge = sniffed.kind === "text" && data.length > TEXT_INLINE_MAX_BYTES;
    const special = specialJsonFile(p);
    return {
      waifuId,
      path: p.virtual,
      display: p.display,
      kind: sniffed.kind,
      contentType: sniffed.contentType,
      size: data.length,
      modified: iso(info.mtimeMs),
      hash: sha256(data),
      ...(sniffed.kind === "text" && !tooLarge ? { text: data.toString("utf8") } : {}),
      ...(tooLarge ? { tooLarge: true as const } : {}),
      ...(isPlacesFile(p) ? { readOnly: true as const } : {}),
      ...(special ? { special } : {}),
      ...(isPrivate ? { private: true as const } : {}),
      includePrivate
    };
  });

  app.put("/api/waifus/:waifuId/files/*", async (request) => {
    const waifuId = waifuIdOf(request.params);
    refuseUnconfirmedAssistant(request);
    const includePrivate = includePrivateOf(request);
    const body = HerFileWriteBodySchema.parse(request.body ?? {});
    const { home, env } = await homeOf(waifuId);
    const p = filePath(home, request);
    if (!includePrivate && (await isPrivateFile(home, p))) throw privateRefused();
    const written = await mapped(() => home.writeText(p, body.text, env(), body.expectedHash !== undefined ? { expectedHash: body.expectedHash } : {}));
    return { waifuId, path: p.virtual, display: p.display, hash: written.hash, size: written.bytes, created: written.created, rewritten: written.rewritten };
  });

  app.delete("/api/waifus/:waifuId/files/*", async (request) => {
    const waifuId = waifuIdOf(request.params);
    refuseUnconfirmedAssistant(request);
    const includePrivate = includePrivateOf(request);
    const query = z.object({ expectedHash: z.string().regex(/^[0-9a-f]{64}$/u).optional() }).parse({ expectedHash: (request.query as Record<string, unknown> | undefined)?.["expectedHash"] });
    const { home, env } = await homeOf(waifuId);
    const p = filePath(home, request);
    if (!includePrivate && (await isPrivateFile(home, p))) throw privateRefused();
    const deleted = await mapped(() => home.deleteFile(p, env(), query.expectedHash !== undefined ? { expectedHash: query.expectedHash } : {}));
    if (!deleted) throw notFound(`${p.display} doesn't exist`);
    // No path in the answer: Remote Access keeps mutation answers for a day.
    return { waifuId, deleted: true as const };
  });

  app.get("/api/waifus/:waifuId/schedule", async (request) => {
    const waifuId = waifuIdOf(request.params);
    const { home } = await homeOf(waifuId);
    const zone = timeZone();
    const [entries, text] = await Promise.all([home.readSchedule(zone), home.readScheduleText()]);
    return { waifuId, timeZone: zone, entries, ...(readsWhole(text, entries.length) ? {} : { unreadable: true as const }) };
  });

  app.delete("/api/waifus/:waifuId/schedule/:reminderId", async (request) => {
    const waifuId = waifuIdOf(request.params);
    const { reminderId } = z.object({ reminderId: z.string().regex(ID) }).parse(request.params);
    const { home } = await homeOf(waifuId);
    const zone = timeZone();
    if (!readsWhole(await home.readScheduleText(), (await home.readSchedule(zone)).length)) {
      throw conflict("Her schedule.json does not read cleanly; fix it in the file editor first.");
    }
    let found = false;
    const clean = await home.rewriteSchedule(zone, (entries) => {
      found = entries.some((entry) => entry.id === reminderId);
      return found ? entries.filter((entry) => entry.id !== reminderId) : entries;
    });
    if (!clean) throw conflict("Her schedule.json does not read cleanly; fix it in the file editor first.");
    if (!found) throw notFound(`Reminder ${reminderId} is not in her schedule.json.`);
    return { waifuId, removed: reminderId };
  });

  app.get("/api/waifus/:waifuId/watches", async (request) => {
    const waifuId = waifuIdOf(request.params);
    const includePrivate = includePrivateOf(request);
    const { home } = await homeOf(waifuId);
    const zone = timeZone();
    const [{ entries, ids }, text] = await Promise.all([home.readWatches(zone), home.readWatchesText()]);
    return {
      waifuId,
      timeZone: zone,
      includePrivate,
      entries: entries.map((entry) => watchView(entry, ids, includePrivate)),
      ...(readsWhole(text, entries.length) ? {} : { unreadable: true as const })
    };
  });

  app.delete("/api/waifus/:waifuId/watches/:watchId", async (request) => {
    const waifuId = waifuIdOf(request.params);
    const { watchId } = z.object({ watchId: z.string().regex(ID) }).parse(request.params);
    const { home } = await homeOf(waifuId);
    const zone = timeZone();
    const unreadable = () => conflict("Her watches.json does not read cleanly; fix it in the file editor first.");
    if (!readsWhole(await home.readWatchesText(), (await home.readWatches(zone)).entries.length)) throw unreadable();
    let found = false;
    const clean = await home.rewriteWatches(zone, (entries, ids) => {
      found = entries.some((entry) => entry.id === watchId);
      if (!found) return { entries, ids };
      const watches = { ...ids.watches };
      delete watches[watchId];
      return { entries: entries.filter((entry) => entry.id !== watchId), ids: { ...ids, watches } };
    });
    if (!clean) throw unreadable();
    if (!found) throw notFound(`Watch ${watchId} is not in her watches.json.`);
    // Only the id: a DM watch's words stay out of the mutation ledger.
    return { waifuId, removed: watchId };
  });
}
