// Durable per-conversation index of the images the app cached for a conversation (bytes in the
// image cache, text in the OCR cache): `user/conversations/<key>/images.json`, plus an append-only
// `images-overflow.jsonl` for keys past the index cap. A forget reads both, together with a legacy
// `ledger.json`'s image refs, so cached images and OCR text are purged even without the live
// conversation cache (after a restart, or on the API path with no runtime).
//
// Who records: the image fetcher (`DiscordImageFetcher.get`) and the OCR service (`cachedText`,
// `textFor`) record a key when the `ImageRef` they are handed carries `conversationKey`. Nothing in
// L1 sets it yet: the code that renders a conversation's messages for a model (L2's life image
// path) must pass `renderDiscordMessage(..., { conversationKey })` so its refs carry the key.
//
// Concurrency: every write for a conversation and the deletion of its directory run on one
// per-conversation queue. A write is skipped when the conversation directory does not exist (it is
// created by the conversation's ref store), so a write queued behind a forget never recreates
// `images.json`; `forgetConversationImageIndex` deletes the directory on that queue after the
// writes queued before it.

import { appendFile, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { resolveDataPath } from "../config/paths.js";
import { atomicWriteJson } from "../storage/atomic.js";
import { conversationDirPath, parseConversationKey, type ConversationKey } from "../orchestration/context/keys.js";

export const CONVERSATION_IMAGE_INDEX_FILE = "images.json";
export const CONVERSATION_IMAGE_OVERFLOW_FILE = "images-overflow.jsonl";
/** Keys kept in `images.json`; older ones move to the append-only overflow file, never dropped. */
export const MAX_INDEXED_KEYS = 5_000;
/** Conversations whose recently recorded keys are remembered in memory (idle ones are evicted first). */
export const MAX_TRACKED_CONVERSATIONS = 256;
/** Recently recorded keys remembered per conversation (a cache: forgetting them only costs a write). */
const MAX_REMEMBERED_KEYS = 1_000;

type IndexState = {
  /** Keys already in the index (in-memory, so a repeat record skips the file). */
  known: Set<string>;
  /** The per-conversation queue: index writes and the directory removal. */
  tail: Promise<void>;
  /** Queued tasks not finished yet; an idle state may be evicted. */
  pending: number;
};

const states = new Map<string, IndexState>();

function stateId(dataRoot: string, key: string): string {
  return `${dataRoot}\u0000${key}`;
}

/** The state for a conversation (most recently used last), evicting idle ones past the bound. */
function stateFor(id: string): IndexState {
  let state = states.get(id);
  if (state) {
    states.delete(id);
    states.set(id, state);
    return state;
  }
  state = { known: new Set(), tail: Promise.resolve(), pending: 0 };
  states.set(id, state);
  if (states.size > MAX_TRACKED_CONVERSATIONS) {
    for (const [candidate, other] of states) {
      if (states.size <= MAX_TRACKED_CONVERSATIONS) break;
      // Never evict a conversation with queued work: its queue must stay the only one.
      if (other.pending === 0 && candidate !== id) states.delete(candidate);
    }
  }
  return state;
}

/** Runs `task` on the conversation's queue, after everything queued before it. */
function enqueue<T>(id: string, task: () => Promise<T>): Promise<T> {
  const state = stateFor(id);
  state.pending += 1;
  const run = state.tail.then(task);
  state.tail = run.then(
    () => undefined,
    () => undefined
  ).finally(() => {
    state.pending -= 1;
  });
  return run;
}

function conversationDir(dataRoot: string, key: string): string | undefined {
  if (!parseConversationKey(key)) return undefined;
  return resolveDataPath(dataRoot, conversationDirPath(key as ConversationKey));
}

/** `user/conversations/<key>/images.json`, or undefined for a malformed key. */
export function conversationImagesPath(dataRoot: string, key: string): string | undefined {
  const dir = conversationDir(dataRoot, key);
  return dir ? path.join(dir, CONVERSATION_IMAGE_INDEX_FILE) : undefined;
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

async function exists(dir: string): Promise<boolean> {
  return stat(dir).then(
    (info) => info.isDirectory(),
    () => false
  );
}

function indexKeys(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const keys = (value as { keys?: unknown }).keys;
  return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string" && key.length > 0) : [];
}

async function overflowKeys(file: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }
  return raw.split("\n").filter((line) => line.length > 0);
}

/** Image keys of a retired context-engine ledger (`ledger.json` entries' `images[].key`). */
function legacyLedgerKeys(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const entries = (value as { entries?: unknown }).entries;
  if (!entries || typeof entries !== "object") return [];
  const keys: string[] = [];
  for (const entry of Object.values(entries as Record<string, unknown>)) {
    const images = entry && typeof entry === "object" ? (entry as { images?: unknown }).images : undefined;
    if (!Array.isArray(images)) continue;
    for (const image of images) {
      const key = image && typeof image === "object" ? (image as { key?: unknown }).key : undefined;
      if (typeof key === "string" && key.length > 0) keys.push(key);
    }
  }
  return keys;
}

/**
 * Adds image keys to a conversation's index. A key already recorded in this process is a no-op. The
 * write is skipped (and the keys forgotten in memory) when the conversation directory does not exist,
 * so nothing recreates a forgotten conversation.
 */
export async function recordConversationImages(dataRoot: string, key: string, imageKeys: readonly string[]): Promise<void> {
  const dir = conversationDir(dataRoot, key);
  if (!dir) return;
  const id = stateId(dataRoot, key);
  const known = stateFor(id).known;
  const fresh = [...new Set(imageKeys)].filter((imageKey) => imageKey.length > 0 && !known.has(imageKey));
  if (fresh.length === 0) return;
  for (const imageKey of fresh) known.add(imageKey);
  if (known.size > MAX_REMEMBERED_KEYS) {
    for (const imageKey of known) {
      if (known.size <= MAX_REMEMBERED_KEYS) break;
      if (!fresh.includes(imageKey)) known.delete(imageKey);
    }
  }
  try {
    await enqueue(id, async () => {
      if (!(await exists(dir))) {
        for (const imageKey of fresh) known.delete(imageKey);
        return;
      }
      const file = path.join(dir, CONVERSATION_IMAGE_INDEX_FILE);
      const merged = [...new Set([...indexKeys(await readJson(file)), ...fresh])];
      const overflow = merged.length > MAX_INDEXED_KEYS ? merged.slice(0, merged.length - MAX_INDEXED_KEYS) : [];
      // The overflow first: a key leaves images.json only once it is durably in the overflow file.
      if (overflow.length > 0) await appendFile(path.join(dir, CONVERSATION_IMAGE_OVERFLOW_FILE), `${overflow.join("\n")}\n`, { mode: 0o600 });
      await atomicWriteJson(file, { keys: merged.slice(merged.length - Math.min(merged.length, MAX_INDEXED_KEYS)) });
    });
  } catch (error) {
    // A failed write must be retried by the next record of these keys.
    for (const imageKey of fresh) known.delete(imageKey);
    throw error;
  }
}

/** Every image key known for a conversation: the index, its overflow and a legacy ledger's refs. */
export async function readConversationImageKeys(dataRoot: string, key: string): Promise<string[]> {
  const dir = conversationDir(dataRoot, key);
  if (!dir) return [];
  return enqueue(stateId(dataRoot, key), async () => {
    const [index, overflow, ledger] = await Promise.all([
      readJson(path.join(dir, CONVERSATION_IMAGE_INDEX_FILE)),
      overflowKeys(path.join(dir, CONVERSATION_IMAGE_OVERFLOW_FILE)),
      readJson(path.join(dir, "ledger.json"))
    ]);
    return [...new Set([...overflow, ...indexKeys(index), ...legacyLedgerKeys(ledger)])];
  });
}

/**
 * The conversation directory goes (forget, thread deletion): `removeDirectory` runs on the
 * conversation's queue after the writes queued before it (they drain into the directory being
 * deleted); writes queued after it find no directory and are skipped. The in-memory state is dropped.
 */
export async function forgetConversationImageIndex(dataRoot: string, key: string, removeDirectory: () => Promise<void>): Promise<void> {
  const id = stateId(dataRoot, key);
  await enqueue(id, async () => {
    await removeDirectory();
    const state = states.get(id);
    state?.known.clear();
  });
  const state = states.get(id);
  if (state && state.pending === 0) states.delete(id);
}

/** Test seam: how many conversations the module tracks in memory. */
export function trackedConversationCount(): number {
  return states.size;
}
