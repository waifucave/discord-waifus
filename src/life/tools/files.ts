// `Read`, `Edit` (and the retired `Write`) over her own folders (Living cast spec §16.3.3, §16.3.4,
// §32.2). Since §32 both take a script: `tools.read_file({ path, offset, limit, pages })` and
// `tools.apply_patch(patch)` (Codex's patch format, applyPatch.ts). Paths are absolute
// (`/home/aria/people/kevin.md`, `/tmp/x.png`), `~`-based or relative to her home; the path rules,
// limits and her special-file checks are the home store's.
//
// read_file gives text with line numbers, a PDF's text with page markers, or an image result: shown
// when she shows it (on a route with image input, within the epoch's image caps; the bytes go into
// the image cache under their hash, pinned for the epoch, so replay never depends on the file),
// else its OCR text; a script's reads are cut at READ_MAX_OUTPUT_CHARS together. A file from a DM is
// recorded as a DM call (D14), so the owner's views hide it. Outside her life (maintenance, a
// forget's scrub: `ctx.mode` "session") an image is always its OCR text and her life's image state
// is never touched. apply_patch checks every file, then saves the whole patch as one change set
// (all or nothing, like Bash's). A whole-file Write of wakeups.json or profile.json (in ~/life/)
// needs a Read of it this turn that is still current (spec §16.14, §30.3).

import { z } from "zod";
import { MAX_INLINE_IMAGE_BYTES } from "../../orchestration/context/images.js";
import type { LifeImageBlock } from "../../shared/schemas/life.js";
import { appendIntent, readLifeState, updateLifeState } from "../lifeStore.js";
import { checkEnvFor, homeStoreFor } from "../home/index.js";
import { HomeError, homeLimitsOf, isTextBytes, PLACES_REFUSED, sha256, sizeText, type HomeStore } from "../home/homeStore.js";
import { HerFilesError } from "../home/herFiles.js";
import { extractPdfText } from "../home/pdf.js";
import { PLAN_WAKE_TEXT } from "../home/daySchedule.js";
import { deleteReachesPlaces, herSlug, isLifeDirPath, isMemoryFile, parseVirtual, pathKey, specialJsonFile, type HerPath } from "../home/pathRules.js";
import { TranscriptView, TRANSCRIPTS_READ_ONLY, transcriptsSegments, transcriptsVirtual } from "../transcripts/view.js";
import { notePlace } from "../placeRecorder.js";
import { wakeupsDmOrigin } from "../wakeups/privacy.js";
import { imageSize } from "../bash/imageCommand.js";
import { PROFILE_TIDY_REFUSED, profileSavedNote } from "./profileNote.js";
import { parseInput, toolError, type LifeResultBlock, type LifeTool, type ToolContext, type ToolOutput } from "./types.js";
import { parsePatch, updateContents } from "./applyPatch.js";
import { failed, familyLines, objectArg, outputText, runScriptTool, scriptSchema, ScriptError, type ScriptRun } from "./script.js";

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

/** Her `/transcripts` for one call (spec §18.3). */
export function transcriptViewOf(ctx: Pick<ToolContext, "deps" | "waifu">): TranscriptView {
  return new TranscriptView({ storage: ctx.deps.storage, waifuId: ctx.waifu.id, timeZone: ctx.deps.timeZone, now: ctx.deps.now });
}

/** The `/transcripts` segments of a path she gave, if it is there. */
function transcriptsArg(ctx: Pick<ToolContext, "deps" | "waifu">, input: string): string[] | undefined {
  return transcriptsSegments(input, herSlug(ctx.waifu));
}

/** Read of a transcript day file (rendered from the store; a private chat's is a DM call, D14). */
async function readTranscript(ctx: ToolContext, segments: string[], offset: number, limit: number, maxChars: number): Promise<ToolOutput> {
  const view = transcriptViewOf(ctx);
  const display = transcriptsVirtual(segments);
  if (await view.isPrivate(segments)) notePlace((await view.conversationOf(segments))?.key ?? "dm_file");
  const stat = await view.stat(segments);
  if (!stat) return toolError(`${display} doesn't exist`);
  if (stat.kind === "dir") return toolError(`${display} is a folder; list it with Bash (ls ${display})`);
  const text = (await view.read(segments)) ?? "";
  if (await view.isPrivate(segments)) {
    const placeKey = (await view.conversationOf(segments))?.key ?? "dm_file";
    rememberTranscriptText(ctx, Buffer.from(text, "utf8"), placeKey);
  }
  return { content: capReadOutput(numbered(text, offset, limit), "offset and limit", maxChars) };
}

/** A private chat's transcript text she was shown this turn (§18.3, D14). */
export function rememberTranscriptText(ctx: Pick<ToolContext, "turn">, data: Uint8Array, placeKey: string): void {
  const sha = sha256(data);
  ctx.turn.transcriptTexts ??= new Map();
  ctx.turn.transcriptTexts.set(sha, { sha256: sha, size: data.length, placeKey });
}

/** A file she just wrote whose bytes are a private chat's transcript she was shown keeps its DM origin. */
async function keepTranscriptOrigin(ctx: ToolContext, store: HomeStore, p: HerPath, hash: string): Promise<void> {
  const text = ctx.turn.transcriptTexts?.get(hash);
  if (!text) return;
  await store.recordTranscriptCopies([{ path: p, sha256: text.sha256, size: text.size, placeKey: text.placeKey }], ctx.deps.now());
  notePlace(text.placeKey);
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
export function capReadOutput(text: string, more: string, max: number = READ_MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const lineEnd = text.lastIndexOf("\n", max);
  const cut = lineEnd > max * 0.8 ? lineEnd : max;
  return `${text.slice(0, cut)}\n(cut at ${cut.toLocaleString("en-US")} characters; pass ${more} to read on)`;
}

/**
 * Records a DM-origin file the call touched (D14, spec §14.4): the owner's views hide the call.
 * Returns the DM it came from (its place key, or `dm_file` when only its folder says so).
 */
export async function noteDmFile(store: HomeStore, p: HerPath): Promise<string | undefined> {
  const origin = (await store.dmOrigin(p).catch(() => undefined)) ?? (await wakeupsOrigin(store, p));
  if (origin) notePlace(origin);
  return origin;
}

/** Her wakeups file holding a private wakeup (or what an everywhere watch kept) shows a DM (D14). */
export async function wakeupsOrigin(store: HomeStore, p: HerPath): Promise<string | undefined> {
  if (p.root !== "home" || specialJsonFile(p) !== "wakeups") return undefined;
  const { entries, side } = await store.readWakeups().catch(() => ({ entries: [], side: undefined }));
  return side ? wakeupsDmOrigin(entries, side) : undefined;
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

/** A picture she read: its header line, and `show` (decides inline or its text, and notes it shown). */
type PreparedImage = { header: string; display: string; show: () => Promise<LifeResultBlock[]> };

/**
 * The picture's bytes go into the image cache now; whether it is shown inline (her epoch's image caps,
 * the route) and that she has seen it are decided only when it is shown (§32.1: `text()` of a
 * `read_file` image result, or the script's return value).
 */
async function prepareImage(ctx: ToolContext, p: HerPath, data: Buffer, mimeType: string, dmOrigin: string | undefined): Promise<PreparedImage> {
  const { deps } = ctx;
  const key = `file:${sha256(data)}`;
  // A picture from a DM is indexed under that DM, so a forget of it purges the cached bytes and
  // their OCR text like any image the DM showed (§7.5).
  const conversationKey = dmOrigin?.startsWith("dm_") && dmOrigin !== "dm_file" ? dmOrigin : undefined;
  const attachment = { key, url: key, filename: p.segments[p.segments.length - 1]!, contentType: mimeType, bytes: data.length, ...(conversationKey ? { conversationKey } : {}) };
  // Her pixel size, so a crop she plans in `image` lands where she means it.
  const size = imageSize(data);
  const header = size ? `${p.display}: ${size.format} ${size.width}x${size.height}, ${sizeText(data.length)}` : `${p.display}: image (${sizeText(data.length)})`;
  const cache = deps.images;
  if (cache?.put) await cache.put(key, { mimeType, data }, conversationKey ? { conversationKey } : {}).catch(() => undefined);
  return { header, display: p.display, show: () => showImage(ctx, { key, header, attachment, data, display: p.display }) };
}

async function showImage(
  ctx: ToolContext,
  o: { key: string; header: string; attachment: Extract<LifeResultBlock, { type: "life_image" }>["attachment"]; data: Buffer; display: string }
): Promise<LifeResultBlock[]> {
  const { deps } = ctx;
  const { key, header, attachment, data } = o;
  const p = { display: o.display };
  const cache = deps.images;
  // Outside her life (maintenance, a scrub) a picture is only its text: her life's image state,
  // caps and pins stay as they are.
  if (ctx.mode === "session") return [{ type: "text", text: header }, { type: "life_image", file: p.display, attachment, mode: await ocrMode(ctx, attachment) }];
  const state = await readLifeState(deps.storage, ctx.waifu.id, deps.now());
  // A picture already shown this epoch is not shown again (it is still in her log above).
  if (state.shownImageKeys.includes(key)) return [{ type: "text", text: header }, { type: "life_image", file: p.display, attachment, mode: await ocrMode(ctx, attachment, { seen: true }) }];
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
  return [{ type: "text", text: header }, block];
}

function pageRange(pages: string | undefined): { first: number; last: number } {
  if (!pages) return { first: 1, last: PDF_DEFAULT_PAGES };
  const [a, b] = pages.split("-").map((part) => Number(part.trim()));
  const first = Math.max(1, a ?? 1);
  return { first, last: Math.max(first, b ?? first) };
}

async function readPdf(ctx: ToolContext, p: HerPath, data: Buffer, pages: string | undefined, maxChars: number): Promise<ToolOutput> {
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
  return { content: capReadOutput(parts.join("\n"), "pages", maxChars) };
}

type ReadArgs = z.infer<typeof ReadInput>;

/**
 * One read (§16.3.3): text with line numbers, a PDF's text, a transcript day, or a picture (prepared:
 * shown when she shows it). `maxChars`: what is left of the output for this script.
 */
async function readFile(args: ReadArgs, ctx: ToolContext, maxChars: number): Promise<ToolOutput | { image: PreparedImage }> {
  const parsed = { value: args };
  const transcript = transcriptsArg(ctx, parsed.value.file_path);
  if (transcript) return readTranscript(ctx, transcript, parsed.value.offset ?? 1, parsed.value.limit ?? READ_DEFAULT_LINES, maxChars);
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
  if (kind.kind === "image") return { image: await prepareImage(ctx, p, data, kind.mimeType, dmOrigin) };
  if (kind.kind === "pdf") return readPdf(ctx, p, data, parsed.value.pages, maxChars);
  if (kind.kind === "text") return { content: capReadOutput(numbered(data.toString("utf8"), parsed.value.offset ?? 1, parsed.value.limit ?? READ_DEFAULT_LINES), "offset and limit", maxChars) };
  return toolError(`${p.display} isn't a text file, an image or a PDF`);
}

/** Read as one call with its old arguments (`file_path`, …): the image shown at once. */
export async function readTool(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = parseInput(ReadInput, input);
  if (!parsed.ok) return parsed.output;
  const result = await readFile(parsed.value, ctx, READ_MAX_OUTPUT_CHARS);
  return "image" in result ? { content: await result.image.show() } : result;
}

/** Dreaming tidies her notes and MEMORY.md only (§21.6): `~/life/` is left alone. */
export const DREAM_LIFE_REFUSED = "error: ~/life/ isn't changed while dreaming (her day, wakeups, profile and places stay as they are); leave it alone";

/**
 * After she changed `~/life/schedule.json` or `MEMORY.md` in her life (§21.2): both have a copy in
 * her system prompt, which updates only at her next summary. Said once per file per turn; never in
 * a session outside her life (no life prompt there), nor for her day when it is kept out of her prompt.
 */
export function promptCopyNote(ctx: Pick<ToolContext, "mode" | "turn" | "waifu">, p: HerPath): string | undefined {
  if (ctx.mode === "session") return undefined;
  const copied = isMemoryFile(p) || (specialJsonFile(p) === "schedule" && ctx.waifu.scheduleInPrompt);
  if (!copied) return undefined;
  const key = pathKey(p.virtual);
  ctx.turn.promptCopyNoted ??= new Set();
  if (ctx.turn.promptCopyNoted.has(key)) return undefined;
  ctx.turn.promptCopyNoted.add(key);
  return promptCopyText(p.display);
}

/**
 * After she changed her day (`~/life/schedule.json`) in her life and it has a plan with a time
 * (§29): those plans wake her then. Said once per turn, never outside her life.
 */
export async function planWakeNote(ctx: Pick<ToolContext, "mode" | "turn">, store: Pick<HomeStore, "readDay">, p: HerPath): Promise<string | undefined> {
  if (ctx.mode === "session" || specialJsonFile(p) !== "schedule") return undefined;
  ctx.turn.promptCopyNoted ??= new Set();
  if (ctx.turn.promptCopyNoted.has(PLAN_NOTE_KEY)) return undefined;
  const day = await store.readDay().catch(() => undefined);
  if (!day?.plans.some((plan) => plan.at !== undefined)) return undefined;
  ctx.turn.promptCopyNoted.add(PLAN_NOTE_KEY);
  return PLAN_WAKE_TEXT;
}

const PLAN_NOTE_KEY = "\0plan-wake";

export function promptCopyText(file: string): string {
  return `The copy of ${file} in your system prompt still shows the old version; it updates at your next summary. The file itself is current.`;
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
  if (transcriptsArg(ctx, parsed.value.file_path)) return toolError(TRANSCRIPTS_READ_ONLY);
  const store = storeOf(ctx);
  const target = await pathArg(store, parsed.value.file_path);
  if (!target.ok) return target.output;
  // A whole-file Write of her wakeups replaces what the app changed since she read it (one fired, ran
  // or ended, the owner deleted one): it needs a current Read.
  // Her day (§21.2) only she and the owner change: a Write needs no Read, but one she read this turn
  // must still be current.
  const special = specialJsonFile(target.path);
  if (ctx.session === "dream" && isLifeDirPath(target.path)) return toolError(DREAM_LIFE_REFUSED);
  if (special === "profile" && ctx.mode === "session") return toolError(PROFILE_TIDY_REFUSED);
  const known = special ? ctx.turn.readHashes?.get(pathKey(target.path.virtual)) : undefined;
  const name = target.path.segments[target.path.segments.length - 1];
  // A file from a DM she replaces (or a new one in a DM's folder) makes the call a DM call (D14).
  await noteDmFile(store, target.path);
  const why = special === "wakeups" ? "a wakeup fired, ran or ended" : special === "profile" ? "your profile was changed for you" : "it was changed for you";
  const guard =
    special && !(special === "schedule" && known === undefined)
      ? {
          expectedHash: known ? known : null,
          staleMessage:
            known === undefined
              ? `error: ${name} already exists; Read it first (Write replaces the whole file)`
              : `error: ${name} changed since you read it (${why}); Read it again`
        }
      : {};
  try {
    const before = await store.hashOf(await store.files.canonical(target.path)).catch(() => undefined);
    const result = await store.writeText(target.path, parsed.value.content, checkEnvFor(ctx.deps, ctx.waifu.id), guard);
    if (special) rememberRead(ctx, result.path, result.hash);
    await keepTranscriptOrigin(ctx, store, result.path, result.hash);
    await noteDmFile(store, result.path);
    const profile = result.profileChanged !== undefined ? `; ${await profileSavedNote(ctx.deps, ctx.waifu.id, result.profileChanged)}` : "";
    const changed = before !== result.hash;
    const notes = changed ? [promptCopyNote(ctx, result.path), await planWakeNote(ctx, store, result.path)].filter(Boolean) : [];
    return { content: `wrote ${result.path.display} (${sizeText(result.bytes)}${result.rewritten ? "; new entries got ids" : ""})${profile}${notes.map((note) => `\n${note}`).join("")}` };
  } catch (error) {
    return failure(error);
  }
}

// ---- Read: tools.read_file (§32.2) ----------------------------------------------------------------------

/** read_file calls in one script, and their output together. */
export const MAX_READS_PER_SCRIPT = 10;

const READ_FILE_FIELDS = ["path", "offset", "limit", "pages"] as const;

/** One `tools.read_file({ path, offset?, limit?, pages? })`: text as a string, a picture as an image result. */
async function readFileCall(arg: unknown, ctx: ToolContext, run: ScriptRun, budget: { left: number }): Promise<unknown> {
  const o = objectArg("read_file", arg, READ_FILE_FIELDS, '{ path: "~/MEMORY.md" }');
  const args = ReadInput.safeParse({ file_path: o["path"], offset: o["offset"], limit: o["limit"], pages: o["pages"] });
  if (!args.success) {
    const issue = args.error.issues[0];
    const field = issue?.path[0] === "file_path" ? "path" : String(issue?.path[0] ?? "path");
    throw new ScriptError(`tools.read_file: ${field}: ${field === "path" ? "a path in your folders, like ~/MEMORY.md" : (issue?.message ?? "invalid")}`, "TypeError");
  }
  if (budget.left <= 0) throw new ScriptError(`tools.read_file: this script has shown ${READ_MAX_OUTPUT_CHARS.toLocaleString("en-US")} characters of files already; read the rest in another call`, "RangeError");
  const result = await readFile(args.data, ctx, budget.left);
  if ("image" in result) {
    const id = `img${run.images.size + 1}`;
    run.images.set(id, result.image.show);
    const about = result.image.header.startsWith(`${result.image.display}: `) ? result.image.header.slice(result.image.display.length + 2) : result.image.header;
    return { path: result.image.display, kind: "image", about, image_id: id };
  }
  if (result.isError) failed(result, "read_file");
  const text = outputText(result);
  budget.left -= text.length;
  return text;
}

async function readScriptTool(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const budget = { left: READ_MAX_OUTPUT_CHARS };
  return runScriptTool(input, ctx, {
    tool: "Read",
    functions: [{ name: "read_file", max: MAX_READS_PER_SCRIPT, run: (arg, run) => readFileCall(arg, ctx, run, budget) }],
    outputChars: READ_MAX_OUTPUT_CHARS
  });
}

// ---- Edit: tools.apply_patch (§32.2) ---------------------------------------------------------------------

/** apply_patch calls in one script. */
export const MAX_PATCHES_PER_SCRIPT = 4;
/** One patch (her script is at most 20,000 characters; a patch she builds in it can be longer). */
export const MAX_PATCH_CHARS = 300 * 1024;
const NOTHING_CHANGED = "; nothing was changed";

/** What one file is while the patch is checked: as on disk at first, then after each hunk. */
/** A file of the patch: `tooLarge` when it is over the write limit (never read: only deleted or named). */
type Simulated = { path: HerPath; original: string | undefined; current: string | undefined; base: { kind: "file"; size: number; mtimeMs: number } | undefined; tooLarge?: boolean };

const patchError = (message: string): never => {
  throw new ScriptError(`tools.apply_patch: ${message.replace(/^error:\s*/u, "")}${NOTHING_CHANGED}`);
};

/**
 * One `tools.apply_patch(patch)`: Codex's grammar and matching (applyPatch.ts), safer: every hunk is
 * checked against her files first (paths by her folder rules, /transcripts read-only, Add File only
 * for a new file, Update and Delete only for an existing text file, 256 KB per file), then the whole
 * patch is saved as one change set through her home store, like a Bash command's (journalled, her
 * special files in ~/life/ checked as they would be after it, places.md untouched, nothing changed
 * under her since it was read): all of it or nothing. Returns `Updated: M ~/MEMORY.md, A ~/x.md`.
 */
async function applyPatchCall(arg: unknown, ctx: ToolContext, n: number, run: ScriptRun): Promise<string> {
  if (typeof arg !== "string") throw new ScriptError('tools.apply_patch takes the patch as one string: "*** Begin Patch\\n*** Update File: ~/MEMORY.md\\n@@\\n-old line\\n+new line\\n*** End Patch"', "TypeError");
  if (arg.length > MAX_PATCH_CHARS) patchError(`a patch is at most ${MAX_PATCH_CHARS / 1024} KB`);
  const parsed = parsePatch(arg);
  if (!parsed.ok) return patchError(parsed.error);
  if (parsed.hunks.length === 0) patchError("the patch changes nothing (add *** Add File, *** Update File or *** Delete File)");
  const { deps } = ctx;
  const store = storeOf(ctx);
  const maxBytes = homeLimitsOf(deps.config().life).writeMaxBytes;
  // Checks, matching and the commit under her home lock (§32.3a): what was matched is what is saved.
  type Committed = { unchanged: string } | { marks: string[]; writes: Array<{ path: string; data: Uint8Array }>; deletes: string[]; applied: Awaited<ReturnType<HomeStore["applyChanges"]>> };
  const committed = await store.transaction<Committed>(async (commit) => {
    const files = new Map<string, Simulated>();
    /** Her path, checked by her folder rules (spelled as on disk), its file read once. */
    const fileAt = async (input: string, verb: string): Promise<Simulated> => {
      const name = input.trim();
      if (transcriptsArg(ctx, name)) patchError(`${name}: ${TRANSCRIPTS_READ_ONLY.replace(/^error:\s*/u, "")}`);
      const target = await pathArg(store, name);
      if (!target.ok) return patchError(`${verb} ${name}: ${outputText(target.output)}`);
      const p = target.path;
      if (deleteReachesPlaces(p)) patchError(PLACES_REFUSED);
      if (ctx.session === "dream" && isLifeDirPath(p)) patchError(DREAM_LIFE_REFUSED);
      if (specialJsonFile(p) === "profile" && ctx.mode === "session") patchError(PROFILE_TIDY_REFUSED);
      // A file from a DM she reads or changes makes the call a DM call (D14).
      await noteDmFile(store, p);
      const key = pathKey(p.virtual);
      const known = files.get(key);
      if (known) return known;
      const info = await store.files.inspect(p);
      if (info.kind === "link") patchError(`${p.display} can't be used: it is a link`);
      if (info.kind === "dir") patchError(`${p.display} is a folder`);
      if (info.kind === "other") patchError(`${p.display} can't be used`);
      let original: string | undefined;
      // A file over the write limit (a big download in /tmp, say) is never read here: matching it
      // would hold her home lock for seconds. It can still be deleted or named; an Update refuses it.
      const tooLarge = info.kind === "file" && info.size > maxBytes;
      if (info.kind === "file" && !tooLarge) {
        const bytes = await store.files.readBytes(p, { maxBytes });
        if (!isTextBytes(bytes)) patchError(`${p.display} isn't a text file`);
        original = bytes.toString("utf8");
      } else if (tooLarge) original = "";
      const entry: Simulated = { path: p, original, current: original, base: info.kind === "file" ? { kind: "file", size: info.size, mtimeMs: info.mtimeMs } : undefined, ...(tooLarge ? { tooLarge } : {}) };
      files.set(key, entry);
      return entry;
    };
    const marks: string[] = [];
    const updatedPaths = new Set<string>();
    for (const hunk of parsed.hunks) {
      if (hunk.kind === "add") {
        const file = await fileAt(hunk.path, "Add File:");
        if (file.current !== undefined) patchError(`Add File: ${file.path.display} already exists; change it with *** Update File`);
        file.current = hunk.contents;
        marks.push(`A ${file.path.display}`);
      } else if (hunk.kind === "delete") {
        const file = await fileAt(hunk.path, "Delete File:");
        if (file.current === undefined) patchError(`Delete File: ${file.path.display} doesn't exist`);
        file.current = undefined;
        marks.push(`D ${file.path.display}`);
      } else {
        const file = await fileAt(hunk.path, "Update File:");
        // One Update per file in a patch: put all its chunks under one header, in file order.
        const key = pathKey(file.path.virtual);
        if (updatedPaths.has(key)) patchError(`${file.path.display} is updated twice in this patch; put all its changes under one *** Update File, in file order`);
        updatedPaths.add(key);
        if (file.current === undefined) patchError(`Update File: ${file.path.display} doesn't exist (a new file is *** Add File)`);
        if (file.tooLarge) patchError(`${file.path.display} is too large to patch (over ${maxBytes / 1024} KB); use Bash`);
        const updated = updateContents(file.current!, hunk.chunks, file.path.display);
        if (!updated.ok) return patchError(updated.error);
        if (hunk.movePath !== undefined && hunk.movePath.trim()) {
          const to = await fileAt(hunk.movePath, "Move to:");
          if (to.path.virtual !== file.path.virtual) {
            if (to.current !== undefined) patchError(`Move to: ${to.path.display} already exists`);
            file.current = undefined;
            to.current = updated.contents;
            marks.push(`M ${to.path.display} (from ${file.path.display})`);
            continue;
          }
        }
        file.current = updated.contents;
        marks.push(`M ${file.path.display}`);
      }
    }
    // The change set: what differs from her files as they were.
    const writes: Array<{ path: string; data: Uint8Array }> = [];
    const deletes: string[] = [];
    const base = new Map<string, { kind: "file" | "dir"; size: number; mtimeMs: number }>();
    for (const file of files.values()) {
      if (file.base) base.set(file.path.virtual, file.base);
      if (file.current === file.original) continue;
      if (file.current === undefined) {
        deletes.push(file.path.virtual);
        continue;
      }
      const data = Buffer.from(file.current, "utf8");
      if (data.length > maxBytes) patchError(`${file.path.display} would be ${sizeText(data.length)}; a file can be at most ${maxBytes / 1024} KB, so split it into several files`);
      writes.push({ path: file.path.virtual, data });
    }
    if (writes.length + deletes.length === 0) return { unchanged: `No change: ${marks.join(", ")} (the files already read like that)` };
    // Intent first, its line done after (boot repair, §5.7): the change set is journalled under this id.
    if (ctx.intent) await appendIntent(deps.storage, ctx.waifu.id, { ...ctx.intent, at: deps.now().toISOString(), line: n, contentDigest: `patch:${n}` });
    let applied: Awaited<ReturnType<HomeStore["applyChanges"]>>;
    try {
      applied = await commit({ writes, deletes, dirs: [] }, base, checkEnvFor(deps, ctx.waifu.id), { journalId: patchJournalId(ctx.toolCallId, n) });
    } catch (error) {
      if (error instanceof HomeError) return patchError(error.message);
      throw error;
    }
    return { marks, writes, deletes, applied };
  });
  if ("unchanged" in committed) return committed.unchanged;
  const { marks, writes, deletes, applied } = committed;
  run.receipts.push(`apply_patch ${n}: saved ${marks.join(", ")}`);
  if (ctx.intent) await appendIntent(deps.storage, ctx.waifu.id, { ...ctx.intent, at: deps.now().toISOString(), line: n, lineDone: true });
  const lines = [`Updated: ${marks.join(", ")}`];
  for (const write of writes) {
    const p = parseVirtual(write.path, store.slug);
    if (!p) continue;
    // A file whose bytes are a private chat's transcript day she was shown keeps its DM origin (§18.3).
    await keepTranscriptOrigin(ctx, store, p, sha256(write.data));
    await noteDmFile(store, p);
  }
  // Her special files changed under her own hand: what she read of them is current again.
  for (const virtual of [...writes.map((write) => write.path), ...deletes]) ctx.turn.readHashes?.delete(pathKey(virtual));
  if (applied.profileChanged !== undefined) lines.push(`profile.json: ${await profileSavedNote(deps, ctx.waifu.id, applied.profileChanged)}`);
  for (const virtual of [...writes.map((write) => write.path), ...deletes]) {
    const p = parseVirtual(virtual, store.slug);
    if (!p) continue;
    const canonical = await store.files.canonical(p);
    const note = promptCopyNote(ctx, canonical);
    if (note) lines.push(note);
    const plans = await planWakeNote(ctx, store, canonical);
    if (plans) lines.push(plans);
  }
  return lines.join("\n");
}

/** The journal id of a script's n-th patch (boot repair finds it by this). */
export function patchJournalId(toolCallId: string, n: number): string {
  return `${toolCallId}-patch${n}`;
}

async function editScriptTool(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  let n = 0;
  // One patch at a time, in the order she called them: a change set's `.applied` marker stays until
  // its done intent is written (the next change set removes it), so boot repair never reports a
  // saved patch unsaved (§32.3a).
  let queue: Promise<unknown> = Promise.resolve();
  return runScriptTool(input, ctx, {
    tool: "Edit",
    functions: [
      {
        name: "apply_patch",
        max: MAX_PATCHES_PER_SCRIPT,
        maxArgChars: MAX_PATCH_CHARS + 1_024,
        run: (arg, run, signal) => {
          const call = (n += 1);
          // Once the script is stopped, a patch still queued never starts.
          const next = queue.then(() => {
            if (signal.aborted || ctx.signal.aborted) throw new ScriptError("tools.apply_patch: the script was stopped before this call started");
            return applyPatchCall(arg, ctx, call, run);
          });
          queue = next.catch(() => undefined);
          return next;
        }
      }
    ]
  });
}

const textPathSchema = { type: "string", description: "A path in your folders: ~/people/kevin.md, /tmp/notes.txt, or relative to your home." };

export const READ_DESCRIPTION = [
  `Read a file from your folders or /transcripts. ${familyLines("read_file")}`,
  "tools.read_file({ path, offset, limit, pages }): text comes back with line numbers (the first 2,000 lines; offset and limit for more); a PDF as text with page markers (the first 20 pages; pages like \"3\" or \"1-5\" for others); a picture as an image result: text() it to see it (when it can't be shown you get any text in it).",
  `At most ${MAX_READS_PER_SCRIPT} reads and ${READ_MAX_OUTPUT_CHARS.toLocaleString("en-US")} characters in one script.`,
  'Example: text(await tools.read_file({ path: "~/MEMORY.md" }))'
].join("\n");

export const EDIT_DESCRIPTION = [
  `Change files in your folders with a patch. ${familyLines("apply_patch")}`,
  "tools.apply_patch(patch) takes one string:",
  "*** Begin Patch",
  "*** Add File: <path> — a new file: each line starts with +",
  "*** Delete File: <path>",
  "*** Update File: <path> — optionally *** Move to: <path>, then chunks: a line @@ (or @@ followed by a line of the file just above, to say where), then the lines around the change starting with a space, removed lines with -, added lines with +",
  "*** End Patch",
  "Copy the lines as they are in the file (Read it first; leave out the line numbers). A chunk without an @@ line that is in the file twice is refused: add a line above or below, or put an @@ line (a line once in the file) above it; under an @@ line the chunk is the first match after it. An @@ line that is in the file twice is refused. A chunk with only + lines is added at the end of the file, even under an @@ line: to insert after a line, include that line as context (a space and the line), then the + lines. One *** Update File per file, its chunks in file order. Everything in the patch is saved, or nothing is (what was saved is listed after your output either way). ~/life/places.md can't be changed, the other files in ~/life/ are checked, /transcripts can't be changed; a file is at most 256 KB. A whole file longer than your script can be is written with Bash.",
  "Write the patch as a list of lines joined, so quotes, backticks and ${…} in your notes stay as they are:",
  'Example: return await tools.apply_patch(["*** Begin Patch", "*** Update File: ~/people/kevin.md", "@@", " likes: brownies", "-exam: friday", "+exam: friday (passed!)", "*** End Patch"].join("\\n"))'
].join("\n");

export const fileTools: LifeTool[] = [
  {
    name: "Read",
    description: READ_DESCRIPTION,
    inputSchema: scriptSchema("JavaScript calling tools.read_file({ path }) and text()."),
    sideEffect: false,
    run: readScriptTool
  },
  {
    // Not offered since §32 (Edit's apply_patch adds files); kept so old log lines still read.
    name: "Write",
    description:
      "Create or replace a text file in your folders (folders are made as needed). ~/life/places.md can't be changed; the other files in ~/life/ are checked before they are saved, and wakeups.json and profile.json need a fresh Read before Write replaces them.",
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
    description: EDIT_DESCRIPTION,
    inputSchema: scriptSchema("JavaScript calling tools.apply_patch(\"*** Begin Patch\\n…\\n*** End Patch\") and text()."),
    sideEffect: true,
    run: editScriptTool
  }
];
