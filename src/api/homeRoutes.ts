// Her own computer over HTTP (Living cast spec §16.11, §30.3): her files in `/home/<slug>` and `/tmp`,
// and her wakeups (`~/life/wakeups.json`, with their sources). Every write goes through her
// HomeStore, so the API's PUT and DELETE are held to the same path rules, limits and checks as her
// Edit tool (`~/life/places.md` refused, the JSON files in `~/life/` checked with line and column).
//
// Paths in URLs are her paths without the leading slash: `files/home/aria/people/kevin.md`,
// `files/tmp/bake-club/general/k3-cake.png` (or `files/~/people/kevin.md`). A file answers as JSON
// (text inline for a UTF-8 text file up to 1 MiB); `?raw=1` answers its bytes with their type
// (images and PDFs by their magic bytes, never by name; anything else as an attachment).
//
// DM content (D14): a file from a private chat (a download from a DM, a copy of one by hash, or
// anything under `/tmp/dm/<handle>/`) and a wakeup watching a DM are private. Listings keep a private
// entry but leave out its name and path (`[private chat redacted]`); reading, writing or deleting a
// private file, or listing a private folder, needs `includePrivate=1`, which only a local request
// may send (403 `PrivateContentLocalOnly` otherwise, and always for the dashboard assistant).
// `wakeups.json` with a wakeup watching a DM (or an "everywhere" watch's state) reads, without
// `includePrivate`, as a redacted copy (that wakeup's note, places, filter and state `[private chat
// redacted]`, read-only); writing or deleting it then needs `includePrivate`. A notes file (`.md`) with lines from private chats (a link to a DM-origin file,
// a DM place or path named, `src/life/notesPrivacy.ts`) reads the same way: a copy with those lines
// `[private chat redacted]`, read-only, whose `hash` is still the file's own; writing or deleting it
// then needs `includePrivate`. Paths compare as her disk does (`/tmp/DM/…` is `/tmp/dm/…`).
// `/transcripts` (§18.3) lists and reads the same way, read-only: a private chat's transcript is
// listed as `[private chat redacted]` and opens only with `includePrivate=1`; PUT and DELETE there
// answer 400 `ReadOnlyFile`.
// Errors never carry host paths: her store's messages name only her paths.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { loadAppConfig } from "../config/appConfig.js";
import { HerFilesError, type HerEntry } from "../life/home/herFiles.js";
import { HomeError, isTextBytes, sha256, type CheckEnv, type HomeStore } from "../life/home/homeStore.js";
import { checkEnvFor, homeStoreFor, offlineCheckEnv } from "../life/home/index.js";
import { isDmFolderPath, isPlacesFile, specialJsonFile, type HerPath, type HerRoot } from "../life/home/pathRules.js";
import { readsWhole } from "../life/wakeups/file.js";
import { redactedWakeupsText, wakeupView } from "../life/wakeups/view.js";
import type { LivingCast } from "../life/livingCast.js";
import { isNotesFile, redactedNotesText } from "../life/notesPrivacy.js";
import { hostTimeZone } from "../orchestration/context/timeFormat.js";
import { readWaifu } from "../orchestration/stores/config.js";
import { PRIVATE_FILE_NAME } from "../shared/constants/files.js";
import { HER_ROOTS, HerFileWriteBodySchema } from "../shared/schemas/api.js";
import type { FilesIndex } from "../shared/schemas/life.js";
import type { StorageService } from "../storage/storageService.js";
import { ApiError, badRequest, conflict, notFound } from "./errors.js";
import { assertSafeId } from "./ids.js";
import { includePrivateOf } from "./lifeRoutes.js";
import { TranscriptView, transcriptsSegments, transcriptsVirtual } from "../life/transcripts/view.js";

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

const WAKEUP_ID = /^[twp]\d{1,6}$/u;

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

/** A folder under `/tmp/dm/<handle>` (or the handle folder itself, any spelling) names a private chat. */
function privateFolder(p: Pick<HerPath, "root" | "segments">): boolean {
  return isDmFolderPath(p) && p.segments.length >= 2;
}

/** Her wakeups.json as the owner may see it without `includePrivate` (undefined: nothing private in it). */
export async function redactedWakeups(home: HomeStore, text: string): Promise<string | "refuse" | undefined> {
  const { entries, side } = await home.readWakeups();
  return redactedWakeupsText(text, entries, side);
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

  /** The `*` part of a files URL → her path, spelled as on disk. */
  const filePath = async (home: HomeStore, request: FastifyRequest, o2: { allowRoot?: boolean } = {}): Promise<HerPath> => {
    const raw = String((request.params as Record<string, unknown>)["*"] ?? "");
    const input = raw.startsWith("~") ? raw : `/${raw}`;
    const resolved = await home.resolveExisting(input, o2);
    if (!resolved.ok) throw badRequest(resolved.error);
    return resolved.path;
  };

  /** A private file (D14), by its folder (any spelling) or its provenance. */
  const isPrivateFile = async (home: HomeStore, p: HerPath, index?: FilesIndex): Promise<boolean> =>
    isDmFolderPath(p) || (await home.dmOrigin(p, index)) !== undefined;

  /** wakeups.json holding a private wakeup can't be replaced or deleted without includePrivate. */
  const refusePrivateWakeups = async (home: HomeStore, p: HerPath, includePrivate: boolean) => {
    if (includePrivate || specialJsonFile(p) !== "wakeups") return;
    const text = await home.readWakeupsText();
    if (text !== undefined && (await redactedWakeups(home, text)) !== undefined) throw privateRefused();
  };

  /** A notes file with lines from private chats can't be replaced or deleted without includePrivate. */
  const refusePrivateNotes = async (home: HomeStore, p: HerPath, includePrivate: boolean) => {
    if (includePrivate || !isNotesFile(p)) return;
    const info = await home.files.inspect(p);
    if (info.kind !== "file") return;
    const text = (await home.files.readBytes(p, { maxBytes: RAW_MAX_BYTES }).catch(() => undefined))?.toString("utf8");
    if (text === undefined || (await redactedNotesText(home, text)) !== undefined) throw privateRefused();
  };

  /** Assistant writes need the owner's click on the confirmation card (§16.11). */
  const refuseUnconfirmedAssistant = (request: FastifyRequest) => {
    if (request.assistantDelegation && !request.assistantDelegation.pendingActionId) {
      throw new ApiError(403, "The dashboard assistant only proposes file changes; the owner confirms them on a dashboard card.", undefined, "AssistantConfirmationRequired");
    }
  };

  /** Her `/transcripts` (§18.3), read-only; a private chat's transcript is D14. */
  const transcriptsOf = (waifuId: string) => new TranscriptView({ storage: o.storage, waifuId, timeZone: timeZone(), now });

  /** The `*` part of a files URL when it is under `/transcripts` (segments below it). */
  const transcriptPathOf = (request: FastifyRequest, slug: string): string[] | undefined => {
    const raw = String((request.params as Record<string, unknown>)["*"] ?? "");
    return raw.startsWith("~") ? undefined : transcriptsSegments(`/${raw}`, slug);
  };

  const listTranscripts = async (waifuId: string, segments: string[], includePrivate: boolean) => {
    const view = transcriptsOf(waifuId);
    // A private chat's folder (or `dm`, which names the people she has private chats with).
    if (!includePrivate && (await view.isPrivate(segments))) throw privateRefused();
    // Stored sizes, as Bash lists them: a listing never renders every day (a day's read gives its own).
    const entries = await view.readdir(segments);
    if (!entries) {
      if (await view.stat(segments)) throw new ApiError(400, `${transcriptsVirtual(segments)} is a file, not a folder`, undefined, "NotFolder");
      throw notFound(`${transcriptsVirtual(segments)} doesn't exist`);
    }
    let redacted = 0;
    const views = [];
    for (const entry of entries) {
      const child = [...segments, entry.name];
      const isPrivate = (await view.conversationOf(child))?.dm === true;
      const hide = isPrivate && !includePrivate;
      if (hide) redacted += 1;
      views.push({
        name: hide ? PRIVATE_FILE_NAME : entry.name,
        ...(hide ? {} : { path: transcriptsVirtual(child) }),
        kind: entry.kind,
        size: entry.size,
        modified: iso(entry.mtimeMs),
        ...(isPrivate ? { private: true as const } : {}),
        ...(hide ? { redacted: true as const } : {})
      });
    }
    return {
      waifuId,
      root: "transcripts" as const,
      dir: transcriptsVirtual(segments),
      display: transcriptsVirtual(segments),
      parent: segments.length === 0 ? null : transcriptsVirtual(segments.slice(0, -1)),
      entries: views,
      includePrivate,
      redacted
    };
  };

  const transcriptsReadOnly = () => new ApiError(400, "Transcripts are read-only.", undefined, "ReadOnlyFile");

  app.get("/api/waifus/:waifuId/files", async (request) => {
    const waifuId = waifuIdOf(request.params);
    const includePrivate = includePrivateOf(request);
    const query = z.object({ root: z.enum(HER_ROOTS).optional(), dir: z.string().max(2000).optional() }).parse(request.query ?? {});
    const { home } = await homeOf(waifuId);
    const transcriptDir = query.dir?.trim().startsWith("/") ? transcriptsSegments(query.dir.trim(), home.slug) : undefined;
    if (transcriptDir || query.root === "transcripts") {
      const dir = query.dir?.trim() ?? "";
      const segments = transcriptDir ?? (dir ? transcriptsSegments(`/transcripts/${dir}`, home.slug) : []);
      if (!segments) throw badRequest(`${dir} is not under /transcripts.`);
      if (query.root && query.root !== "transcripts") throw badRequest(`${dir} is not under ${query.root === "home" ? "her home" : "/tmp"}.`);
      return listTranscripts(waifuId, segments, includePrivate);
    }
    let folder: HerPath;
    const dir = query.dir?.trim() ?? "";
    if (dir.startsWith("/") || dir.startsWith("~")) {
      const resolved = await home.resolveExisting(dir, { allowRoot: true });
      if (!resolved.ok) throw badRequest(resolved.error);
      if (query.root && resolved.path.root !== query.root) throw badRequest(`${dir} is not under ${query.root === "home" ? "her home" : "/tmp"}.`);
      folder = resolved.path;
    } else {
      const root: HerRoot = query.root ?? "home";
      const resolved = await home.resolveExisting(dir ? `${root === "home" ? "~" : "/tmp"}/${dir}` : root === "home" ? "~" : "/tmp", { allowRoot: true });
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
          : { bytes: usage.bytes, files: usage.files, maxBytes: config.life.tmp.maxBytes, maxFiles: config.life.tmp.maxFiles, retentionDays: config.life.tmp.retentionDays }
    };
  });

  app.get("/api/waifus/:waifuId/files/*", async (request, reply: FastifyReply) => {
    const waifuId = waifuIdOf(request.params);
    const includePrivate = includePrivateOf(request);
    const { raw } = z.object({ raw: z.enum(["0", "1", "true", "false"]).optional() }).parse({ raw: (request.query as Record<string, unknown> | undefined)?.["raw"] });
    const { home } = await homeOf(waifuId);
    const transcript = transcriptPathOf(request, home.slug);
    if (transcript) {
      const view = transcriptsOf(waifuId);
      const virtual = transcriptsVirtual(transcript);
      if (!includePrivate && (await view.isPrivate(transcript))) throw privateRefused();
      const stat = await view.stat(transcript);
      if (!stat) throw notFound(`${virtual} doesn't exist`);
      if (stat.kind === "dir") throw new ApiError(400, `${virtual} is a folder, not a file (list it with GET /api/waifus/${waifuId}/files?dir=${virtual})`, undefined, "IsFolder");
      const text = (await view.read(transcript)) ?? "";
      const data = Buffer.from(text, "utf8");
      if (raw === "1" || raw === "true") {
        return reply
          .header("content-type", "text/plain; charset=utf-8")
          .header("x-content-type-options", "nosniff")
          .header("content-security-policy", "default-src 'none'; sandbox")
          .header("content-disposition", `attachment; filename="${(transcript.at(-1) ?? "transcript.md").replace(/[^\w.-]+/gu, "_")}"`)
          .send(data);
      }
      const isPrivate = (await view.conversationOf(transcript))?.dm === true;
      return {
        waifuId,
        path: virtual,
        display: virtual,
        kind: "text" as const,
        contentType: "text/plain; charset=utf-8",
        size: data.length,
        modified: iso(stat.mtimeMs),
        hash: sha256(data),
        ...(data.length > TEXT_INLINE_MAX_BYTES ? { tooLarge: true as const } : { text }),
        readOnly: true as const,
        ...(isPrivate ? { private: true as const } : {}),
        includePrivate
      };
    }
    const p = await filePath(home, request);
    const info = await home.files.inspect(p);
    if (info.kind === "missing") throw notFound(`${p.display} doesn't exist`);
    if (info.kind === "link") throw new ApiError(400, `${p.display} can't be used: it is a link`, undefined, "LinkRefused");
    if (info.kind !== "file") throw new ApiError(400, `${p.display} is a folder, not a file (list it with GET /api/waifus/${waifuId}/files?dir=…)`, undefined, "IsFolder");
    const isPrivate = await isPrivateFile(home, p);
    if (isPrivate && !includePrivate) throw privateRefused();
    if (info.size > RAW_MAX_BYTES) throw new ApiError(413, `${p.display} is too large to open here`, undefined, "HomeLimit");
    const onDisk = await mapped(() => home.files.readBytes(p, { maxBytes: RAW_MAX_BYTES }));
    let data = onDisk;
    let sniffed = sniffKind(data);
    // A private wakeup's words never leave the host without includePrivate.
    let redactedFile = false;
    if (!includePrivate && specialJsonFile(p) === "wakeups") {
      const redacted = await redactedWakeups(home, data.toString("utf8"));
      if (redacted === "refuse") throw privateRefused();
      if (redacted !== undefined) {
        data = Buffer.from(redacted, "utf8");
        sniffed = sniffKind(data);
        redactedFile = true;
      }
    }
    // Her notes' lines from private chats stay on the host without includePrivate (D14).
    if (!includePrivate && !redactedFile && sniffed.kind === "text" && isNotesFile(p)) {
      const redacted = await redactedNotesText(home, data.toString("utf8"));
      if (redacted !== undefined) {
        data = Buffer.from(redacted, "utf8");
        redactedFile = true;
      }
    }
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
      // The revision is always the file on disk (a redacted copy is read-only; a reveal edits the file).
      hash: sha256(onDisk),
      ...(sniffed.kind === "text" && !tooLarge ? { text: data.toString("utf8") } : {}),
      ...(tooLarge ? { tooLarge: true as const } : {}),
      ...(isPlacesFile(p) || redactedFile ? { readOnly: true as const } : {}),
      ...(special ? { special } : {}),
      ...(isPrivate || redactedFile ? { private: true as const } : {}),
      ...(redactedFile ? { redacted: true as const } : {}),
      includePrivate
    };
  });

  app.put("/api/waifus/:waifuId/files/*", async (request) => {
    const waifuId = waifuIdOf(request.params);
    refuseUnconfirmedAssistant(request);
    if (transcriptPathOf(request, (await homeOf(waifuId)).home.slug)) throw transcriptsReadOnly();
    const includePrivate = includePrivateOf(request);
    const body = HerFileWriteBodySchema.parse(request.body ?? {});
    const { home, env } = await homeOf(waifuId);
    const p = await filePath(home, request);
    if (!includePrivate && (await isPrivateFile(home, p))) throw privateRefused();
    await refusePrivateWakeups(home, p, includePrivate);
    await refusePrivateNotes(home, p, includePrivate);
    const written = await mapped(() => home.writeText(p, body.text, env(), body.expectedHash !== undefined ? { expectedHash: body.expectedHash } : {}));
    // Her profile.json is her config (§17.1): her bot follows it.
    if (written.profileChanged) void o.cast()?.deps.profileSync?.syncWaifu(waifuId).catch(() => undefined);
    return { waifuId, path: p.virtual, display: p.display, hash: written.hash, size: written.bytes, created: written.created, rewritten: written.rewritten };
  });

  app.delete("/api/waifus/:waifuId/files/*", async (request) => {
    const waifuId = waifuIdOf(request.params);
    refuseUnconfirmedAssistant(request);
    if (transcriptPathOf(request, (await homeOf(waifuId)).home.slug)) throw transcriptsReadOnly();
    const includePrivate = includePrivateOf(request);
    const query = z.object({ expectedHash: z.string().regex(/^[0-9a-f]{64}$/u).optional() }).parse({ expectedHash: (request.query as Record<string, unknown> | undefined)?.["expectedHash"] });
    const { home, env } = await homeOf(waifuId);
    const p = await filePath(home, request);
    if (!includePrivate && (await isPrivateFile(home, p))) throw privateRefused();
    await refusePrivateWakeups(home, p, includePrivate);
    await refusePrivateNotes(home, p, includePrivate);
    const deleted = await mapped(() => home.deleteFile(p, env(), query.expectedHash !== undefined ? { expectedHash: query.expectedHash } : {}));
    if (!deleted) throw notFound(`${p.display} doesn't exist`);
    // No path in the answer: Remote Access keeps mutation answers for a day.
    return { waifuId, deleted: true as const };
  });

  app.get("/api/waifus/:waifuId/wakeups", async (request) => {
    const waifuId = waifuIdOf(request.params);
    const includePrivate = includePrivateOf(request);
    const { home } = await homeOf(waifuId);
    const zone = timeZone();
    const { entries, side, text } = await home.readWakeups();
    return {
      waifuId,
      timeZone: zone,
      includePrivate,
      entries: entries.map((entry) => wakeupView(entry, side, { includePrivate, timeZone: zone, now: now() })),
      ...(readsWhole(text, entries.length) ? {} : { unreadable: true as const })
    };
  });

  app.delete("/api/waifus/:waifuId/wakeups/:wakeupId", async (request) => {
    const waifuId = waifuIdOf(request.params);
    const { wakeupId } = z.object({ wakeupId: z.string().regex(WAKEUP_ID) }).parse(request.params);
    const { home } = await homeOf(waifuId);
    const unreadable = () => conflict("Her life/wakeups.json does not read cleanly; fix it in the file editor first.");
    const { entries, text } = await home.readWakeups();
    if (!readsWhole(text, entries.length)) throw unreadable();
    let found = false;
    const { clean } = await home.rewriteWakeups((current, side) => {
      found = current.some((entry) => entry.id === wakeupId);
      if (!found) return { entries: current, side };
      const watches = { ...side.watches };
      const every = { ...side.every };
      const pages = { ...side.pages };
      delete watches[wakeupId];
      delete every[wakeupId];
      delete pages[wakeupId];
      return { entries: current.filter((entry) => entry.id !== wakeupId), side: { ...side, watches, every, pages } };
    });
    if (!clean) throw unreadable();
    if (!found) throw notFound(`Wakeup ${wakeupId} is not in her life/wakeups.json.`);
    // Only the id: a private wakeup's words stay out of the mutation ledger.
    return { waifuId, removed: wakeupId };
  });
}
