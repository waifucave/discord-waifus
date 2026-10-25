// `Read`, `Write`, `Edit` over her own folders (Living cast spec §16.3.3, §16.3.4), like Claude
// Code's file tools. Paths are absolute (`/home/aria/people/kevin.md`, `/tmp/x.png`), `~`-based or
// relative to her home; the path rules, limits and her special-file checks are the home store's.
//
// Read shows text with line numbers, an image (on a route with image input, within the epoch's
// image caps; the bytes go into the image cache under their hash, pinned for the epoch, so replay
// never depends on the file) or its OCR text, or a PDF's text with page markers; its output is cut
// at READ_MAX_OUTPUT_CHARS. A file from a DM is recorded as a DM call (D14), so the owner's views
// hide it. Outside her life (maintenance, a forget's scrub: `ctx.mode` "session") an image is always
// its OCR text and her life's image state is never touched. A whole-file Write of schedule.json or
// watches.json needs a Read of it this turn that is still current (spec §16.4, §16.5).

import { z } from "zod";
import { MAX_INLINE_IMAGE_BYTES } from "../../orchestration/context/images.js";
import type { LifeImageBlock } from "../../shared/schemas/life.js";
import { readLifeState, updateLifeState } from "../lifeStore.js";
import { checkEnvFor, homeStoreFor } from "../home/index.js";
import { HomeError, isTextBytes, sha256, sizeText, type HomeStore } from "../home/homeStore.js";
import { HerFilesError } from "../home/herFiles.js";
import { extractPdfText } from "../home/pdf.js";
import { pathKey, specialJsonFile, type HerPath } from "../home/pathRules.js";
import { notePlace } from "../placeRecorder.js";
import { PROFILE_TIDY_REFUSED, profileSavedNote } from "./profileNote.js";
import { parseInput, toolError, type LifeResultBlock, type LifeTool, type ToolContext, type ToolOutput } from "./types.js";

export const READ_DEFAULT_LINES = 2_000;
export const READ_MAX_LINE_CHARS = 2_000;
export const READ_MAX_BYTES = 10 * 1024 * 1024;
export const PDF_DEFAULT_PAGES = 20;
/** About 25k tokens: a Read result is cut here (whole lines, whole pages where possible). */
export const READ_MAX_OUTPUT_CHARS = 100_000;
const OCR_TIMEOUT_MS = 4_000;

export function storeOf(ctx: Pick<ToolContext, "deps" | "waifu">): HomeStore {
  return homeStoreFor(ctx.deps, ctx.waifu);
}

/**
 * A checked path spelled as on disk (`~/Memory.md` is `~/MEMORY.md` when that exists, so every
 * check by name sees the real file), or the error result.
 */
export async function pathArg(store: HomeStore, input: string, o: { allowRoot?: boolean } = {}): Promise<{ ok: true; path: HerPath } | { ok: false; output: ToolOutput }> {
  const resolved = await store.resolveExisting(input, o);
  return resolved.ok ? resolved : { ok: false, output: toolError(resolved.error) };
}

/** Cuts a Read result at READ_MAX_OUTPUT_CHARS, on a line break when there is one near. */
export function capReadOutput(text: string, more: string): string {
  if (text.length <= READ_MAX_OUTPUT_CHARS) return text;
  const lineEnd = text.lastIndexOf("\n", READ_MAX_OUTPUT_CHARS);
  const cut = lineEnd > READ_MAX_OUTPUT_CHARS * 0.8 ? lineEnd : READ_MAX_OUTPUT_CHARS;
  return `${text.slice(0, cut)}\n(cut at ${cut.toLocaleString("en-US")} characters; pass ${more} to read on)`;
}

/**
 * Records a DM-origin file the call touched (D14, spec §14.4): the owner's views hide the call.
 * Returns the DM it came from (its place key, or `dm_file` when only its folder says so).
 */
export async function noteDmFile(store: HomeStore, p: HerPath): Promise<string | undefined> {
  const origin = await store.dmOrigin(p).catch(() => undefined);
  if (origin) notePlace(origin);
  return origin;
}

function failure(error: unknown): ToolOutput {
  if (error instanceof HomeError || error instanceof HerFilesError) return toolError(error.message);
  throw error;
}

type Sniffed = { kind: "image"; mimeType: string } | { kind: "pdf" } | { kind: "text" } | { kind: "other" };

/** What a file is, by its first bytes. */
export function sniff(data: Uint8Array): Sniffed {
  const starts = (...bytes: number[]) => bytes.every((byte, index) => data[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return { kind: "image", mimeType: "image/png" };
  if (starts(0xff, 0xd8, 0xff)) return { kind: "image", mimeType: "image/jpeg" };
  if (starts(0x47, 0x49, 0x46, 0x38)) return { kind: "image", mimeType: "image/gif" };
  if (starts(0x52, 0x49, 0x46, 0x46) && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return { kind: "image", mimeType: "image/webp" };
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return { kind: "pdf" };
  return isTextBytes(data) ? { kind: "text" } : { kind: "other" };
}

// ---- Read ------------------------------------------------------------------------------------------

const ReadInput = z.object({
  file_path: z.string().min(1).max(2000),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(READ_DEFAULT_LINES).optional(),
  pages: z
    .string()
    .regex(/^\s*\d+\s*(?:-\s*\d+\s*)?$/u, 'pages is a page or a range, like "3" or "1-5"')
    .optional()
});

function numbered(text: string, offset: number, limit: number): string {
  if (text.length === 0) return "(empty file)";
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const start = Math.min(offset, lines.length + 1);
  const shown = lines.slice(start - 1, start - 1 + limit);
  if (shown.length === 0) return `(the file has ${lines.length} lines; nothing at line ${offset})`;
  const out = shown.map((line, index) => {
    const cut = [...line].length > READ_MAX_LINE_CHARS ? `${[...line].slice(0, READ_MAX_LINE_CHARS).join("")}…` : line;
    return `${String(start + index).padStart(6)}\t${cut}`;
  });
  const last = start - 1 + shown.length;
  if (start > 1 || last < lines.length) out.push(`(lines ${start}–${last} of ${lines.length}${last < lines.length ? `; pass offset ${last + 1} to read on` : ""})`);
  return out.join("\n");
}

async function ocrMode(ctx: ToolContext, attachment: Parameters<NonNullable<ToolContext["deps"]["ocr"]>["cachedText"]>[0], o: { seen?: boolean } = {}): Promise<LifeImageBlock["mode"]> {
  const { deps } = ctx;
  const cached = await deps.ocr?.cachedText(attachment).catch(() => undefined);
  const text = cached ?? (deps.images ? await deps.ocr?.textFor?.(attachment, { timeoutMs: OCR_TIMEOUT_MS, signal: ctx.signal }).catch(() => undefined) : undefined);
  const clean = (text ?? "").replace(/\s+/gu, " ").trim();
  if (o.seen) return { text: clean ? `[image: you've already seen this picture; the text in it: ${clean}]` : "[image: you've already seen this picture]" };
  return { text: clean ? `[image: ${clean}]` : "[image: no text found]" };
}

async function readImage(ctx: ToolContext, p: HerPath, data: Buffer, mimeType: string, dmOrigin: string | undefined): Promise<ToolOutput> {
  const { deps } = ctx;
  const key = `file:${sha256(data)}`;
  // A picture from a DM is indexed under that DM, so a forget of it purges the cached bytes and
  // their OCR text like any image the DM showed (§7.5).
  const conversationKey = dmOrigin?.startsWith("dm_") && dmOrigin !== "dm_file" ? dmOrigin : undefined;
  const attachment = { key, url: key, filename: p.segments[p.segments.length - 1]!, contentType: mimeType, bytes: data.length, ...(conversationKey ? { conversationKey } : {}) };
  const header = `${p.display}: image (${sizeText(data.length)})`;
  const cache = deps.images;
  if (cache?.put) await cache.put(key, { mimeType, data }, conversationKey ? { conversationKey } : {}).catch(() => undefined);
  // Outside her life (maintenance, a scrub) a picture is only its text: her life's image state,
  // caps and pins stay as they are.
  if (ctx.mode === "session") return { content: [{ type: "text", text: header }, { type: "life_image", file: p.display, attachment, mode: await ocrMode(ctx, attachment) }] };
  const state = await readLifeState(deps.storage, ctx.waifu.id, deps.now());
  // A picture already shown this epoch is not shown again (it is still in her log above).
  if (state.shownImageKeys.includes(key)) return { content: [{ type: "text", text: header }, { type: "life_image", file: p.display, attachment, mode: await ocrMode(ctx, attachment, { seen: true }) }] };
  const life = deps.config().life;
  const inline =
    ctx.route.imageInput &&
    cache?.put !== undefined &&
    data.length <= MAX_INLINE_IMAGE_BYTES &&
    state.inlineImageCount + 1 <= life.maxInlineImagesPerEpoch &&
    state.inlineImageBytes + data.length <= life.maxInlineImageBytesPerEpoch;
  let mode: LifeImageBlock["mode"];
  if (inline) {
    mode = "inline";
  } else {
    mode = await ocrMode(ctx, attachment);
  }
  await updateLifeState(deps.storage, ctx.waifu.id, (current) => ({
    ...current,
    shownImageKeys: [...new Set([...current.shownImageKeys, key])],
    ...(inline ? { inlineImageCount: current.inlineImageCount + 1, inlineImageBytes: current.inlineImageBytes + data.length } : {})
  }));
  const block: LifeImageBlock = { type: "life_image", file: p.display, attachment, mode };
  const blocks: LifeResultBlock[] = [{ type: "text", text: header }, block];
  return { content: blocks };
}

function pageRange(pages: string | undefined): { first: number; last: number } {
  if (!pages) return { first: 1, last: PDF_DEFAULT_PAGES };
  const [a, b] = pages.split("-").map((part) => Number(part.trim()));
  const first = Math.max(1, a ?? 1);
  return { first, last: Math.max(first, b ?? first) };
}

async function readPdf(ctx: ToolContext, p: HerPath, data: Buffer, pages: string | undefined): Promise<ToolOutput> {
  const range = pageRange(pages);
  if (range.last - range.first + 1 > 50) return toolError("read at most 50 pages at a time");
  const result = await extractPdfText(data, { ...range, signal: ctx.signal });
  if (!result.ok) return toolError(`${p.display} could not be read: ${result.error}`);
  if (result.pages.length === 0) return toolError(`${p.display} has ${result.totalPages} page${result.totalPages === 1 ? "" : "s"}; nothing at page ${range.first}`);
  const parts = [`${p.display}: PDF, ${result.totalPages} page${result.totalPages === 1 ? "" : "s"}`];
  for (const page of result.pages) parts.push(`--- page ${page.page} ---\n${page.text || "(no text on this page)"}`);
  if (result.pages.every((page) => !page.text)) parts.push("(no text found: it is probably scanned images)");
  const last = result.pages[result.pages.length - 1]!.page;
  if (last < result.totalPages) parts.push(`(pages ${range.first}–${last} of ${result.totalPages}; pass pages like "${last + 1}-${Math.min(result.totalPages, last + PDF_DEFAULT_PAGES)}" to read on)`);
  return { content: capReadOutput(parts.join("\n"), "pages") };
}

async function readTool(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = parseInput(ReadInput, input);
  if (!parsed.ok) return parsed.output;
  const store = storeOf(ctx);
  const target = await pathArg(store, parsed.value.file_path);
  if (!target.ok) return target.output;
  const p = target.path;
  if (specialJsonFile(p) && (await store.files.inspect(p)).kind === "missing") rememberRead(ctx, p, null);
  const info = await store.files.inspect(p);
  if (info.kind === "missing") return toolError(`${p.display} doesn't exist`);
  if (info.kind === "link") return toolError(`${p.display} can't be used: it is a link`);
  if (info.kind === "dir") return toolError(`${p.display} is a folder; list it with Bash (ls ${p.display})`);
  if (info.kind !== "file") return toolError(`${p.display} isn't a text file, an image or a PDF`);
  if (info.size > READ_MAX_BYTES) return toolError(`${p.display} is too large to read (${sizeText(info.size)})`);
  let data: Buffer;
  try {
    data = await store.files.readBytes(p, { maxBytes: READ_MAX_BYTES });
  } catch (error) {
    return failure(error);
  }
  const dmOrigin = await noteDmFile(store, p);
  if (specialJsonFile(p)) rememberRead(ctx, p, sha256(data));
  const kind = sniff(data);
  if (kind.kind === "image") return readImage(ctx, p, data, kind.mimeType, dmOrigin);
  if (kind.kind === "pdf") return readPdf(ctx, p, data, parsed.value.pages);
  if (kind.kind === "text") return { content: capReadOutput(numbered(data.toString("utf8"), parsed.value.offset ?? 1, parsed.value.limit ?? READ_DEFAULT_LINES), "offset and limit") };
  return toolError(`${p.display} isn't a text file, an image or a PDF`);
}

/** What she last read of a special file this turn (`null`: it didn't exist). */
function rememberRead(ctx: ToolContext, p: HerPath, hash: string | null): void {
  ctx.turn.readHashes ??= new Map();
  ctx.turn.readHashes.set(pathKey(p.virtual), hash ?? "");
}

// ---- Write -----------------------------------------------------------------------------------------

const WriteInput = z.object({ file_path: z.string().min(1).max(2000), content: z.string() });

async function writeTool(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = parseInput(WriteInput, input);
  if (!parsed.ok) return parsed.output;
  const store = storeOf(ctx);
  const target = await pathArg(store, parsed.value.file_path);
  if (!target.ok) return target.output;
  // A whole-file Write of her reminders or watches replaces what the app changed since she read it
  // (a reminder fired, a watch matched or timed out, the owner deleted one): it needs a current Read.
  const special = specialJsonFile(target.path);
  if (special === "profile" && ctx.mode === "session") return toolError(PROFILE_TIDY_REFUSED);
  const known = special ? ctx.turn.readHashes?.get(pathKey(target.path.virtual)) : undefined;
  const name = target.path.segments[0];
  // A file from a DM she replaces (or a new one in a DM's folder) makes the call a DM call (D14).
  await noteDmFile(store, target.path);
  const why = special === "watches" ? "a watch matched or timed out" : special === "profile" ? "your profile was changed for you" : "a reminder fired";
  const guard = special
    ? {
        expectedHash: known ? known : null,
        staleMessage:
          known === undefined
            ? `error: ${name} already exists; Read it first (Write replaces the whole file)`
            : `error: ${name} changed since you read it (${why}); Read it again`
      }
    : {};
  try {
    const result = await store.writeText(target.path, parsed.value.content, checkEnvFor(ctx.deps, ctx.waifu.id), guard);
    if (special) rememberRead(ctx, result.path, result.hash);
    await noteDmFile(store, result.path);
    const profile = result.profileChanged !== undefined ? `; ${await profileSavedNote(ctx.deps, ctx.waifu.id, result.profileChanged)}` : "";
    return { content: `wrote ${result.path.display} (${sizeText(result.bytes)}${result.rewritten ? "; new entries got ids" : ""})${profile}` };
  } catch (error) {
    return failure(error);
  }
}

// ---- Edit ------------------------------------------------------------------------------------------

const EditInput = z.object({
  file_path: z.string().min(1).max(2000),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional()
});

async function editTool(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = parseInput(EditInput, input);
  if (!parsed.ok) return parsed.output;
  const store = storeOf(ctx);
  const target = await pathArg(store, parsed.value.file_path);
  if (!target.ok) return target.output;
  if (specialJsonFile(target.path) === "profile" && ctx.mode === "session") return toolError(PROFILE_TIDY_REFUSED);
  await noteDmFile(store, target.path);
  try {
    const result = await store.editText(target.path, parsed.value.old_string, parsed.value.new_string, parsed.value.replace_all === true, checkEnvFor(ctx.deps, ctx.waifu.id));
    // Her view of the file now includes her edit (an earlier stale Read stays stale).
    const key = pathKey(target.path.virtual);
    if (specialJsonFile(target.path) && ctx.turn.readHashes?.has(key)) rememberRead(ctx, target.path, result.hash);
    const extra = [result.count > 1 ? `${result.count} replacements` : undefined, result.rewritten ? "new entries got ids" : undefined].filter(Boolean);
    const profile = result.profileChanged !== undefined ? `; ${await profileSavedNote(ctx.deps, ctx.waifu.id, result.profileChanged)}` : "";
    return { content: `edited ${target.path.display}${extra.length > 0 ? ` (${extra.join("; ")})` : ""}${profile}` };
  } catch (error) {
    return failure(error);
  }
}

const pathSchema = { type: "string", description: "A path in your folders: ~/people/kevin.md, /tmp/bake-club/general/k3-cake.png, or relative to your home." };
const textPathSchema = { type: "string", description: "A path in your folders: ~/people/kevin.md, /tmp/notes.txt, or relative to your home." };

export const fileTools: LifeTool[] = [
  {
    name: "Read",
    description:
      "Read a file from your folders. Text comes back with line numbers (the first 2000 lines; use offset and limit for more). Images are shown to you; when they can't be, you get any text in them. PDFs come back as text with page markers (the first 20 pages; use pages for others).",
    inputSchema: {
      type: "object",
      properties: {
        file_path: pathSchema,
        offset: { type: "integer", minimum: 1, description: "Text: the line to start at." },
        limit: { type: "integer", minimum: 1, maximum: READ_DEFAULT_LINES, description: "Text: how many lines." },
        pages: { type: "string", description: 'PDF: a page or a range, like "3" or "1-5".' }
      },
      required: ["file_path"],
      additionalProperties: false
    },
    sideEffect: false,
    run: readTool
  },
  {
    name: "Write",
    description:
      "Create or replace a text file in your folders (folders are made as needed). For changes to an existing file, Edit is usually better. places.md can't be changed; schedule.json and watches.json are checked before they are saved, and need a fresh Read before Write replaces them.",
    inputSchema: {
      type: "object",
      properties: { file_path: textPathSchema, content: { type: "string", description: "The whole file (at most 256 KB)." } },
      required: ["file_path", "content"],
      additionalProperties: false
    },
    sideEffect: true,
    run: writeTool
  },
  {
    name: "Edit",
    description:
      "Replace text in a file: old_string must appear exactly once (include enough around it), unless replace_all is true. Read the file first so you match it exactly. Leave out the line numbers Read shows.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: textPathSchema,
        old_string: { type: "string", description: "The exact text to replace." },
        new_string: { type: "string", description: "What replaces it." },
        replace_all: { type: "boolean", description: "Replace every occurrence (default false)." }
      },
      required: ["file_path", "old_string", "new_string"],
      additionalProperties: false
    },
    sideEffect: true,
    run: editTool
  }
];
