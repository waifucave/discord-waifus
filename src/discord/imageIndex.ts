// Durable per-conversation index of the images the app cached for a conversation (bytes in the
// image cache, text in the OCR cache): `user/conversations/<key>/images.json`. A forget reads it,
// together with a legacy `ledger.json`'s image refs, so cached images and OCR text are purged even
// without the live conversation cache (after a restart, or on the API path with no runtime).
//
// Image refs carry their conversation (`ImageRef.conversationKey`, set by the renderer); the image
// fetcher and the OCR service record each key the first time they serve it for that conversation.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveDataPath } from "../config/paths.js";
import { atomicWriteJson } from "../storage/atomic.js";
import { conversationDirPath, parseConversationKey, type ConversationKey } from "../orchestration/context/keys.js";

export const CONVERSATION_IMAGE_INDEX_FILE = "images.json";
/** Oldest keys fall off past this many (a conversation's whole image history is far smaller). */
const MAX_INDEXED_KEYS = 5_000;

const recorded = new Map<string, Set<string>>();
const writes = new Map<string, Promise<void>>();

function indexId(dataRoot: string, key: string): string {
  return `${dataRoot}\u0000${key}`;
}

/** `user/conversations/<key>/images.json`, or undefined for a malformed key. */
export function conversationImagesPath(dataRoot: string, key: string): string | undefined {
  if (!parseConversationKey(key)) return undefined;
  return resolveDataPath(dataRoot, conversationDirPath(key as ConversationKey), CONVERSATION_IMAGE_INDEX_FILE);
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function indexKeys(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const keys = (value as { keys?: unknown }).keys;
  return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string" && key.length > 0) : [];
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

/** Adds image keys to a conversation's index (serialised per conversation; a known key is a no-op). */
export async function recordConversationImages(dataRoot: string, key: string, imageKeys: readonly string[]): Promise<void> {
  const file = conversationImagesPath(dataRoot, key);
  if (!file) return;
  const id = indexId(dataRoot, key);
  let known = recorded.get(id);
  if (!known) {
    known = new Set();
    recorded.set(id, known);
  }
  const fresh = [...new Set(imageKeys)].filter((imageKey) => imageKey.length > 0 && !known.has(imageKey));
  if (fresh.length === 0) return;
  for (const imageKey of fresh) known.add(imageKey);
  const previous = writes.get(id) ?? Promise.resolve();
  const write = previous.then(async () => {
    const merged = [...new Set([...indexKeys(await readJson(file)), ...fresh])].slice(-MAX_INDEXED_KEYS);
    await atomicWriteJson(file, { keys: merged });
  });
  const settled = write.catch(() => {
    // A failed write must be retried by the next record of these keys.
    for (const imageKey of fresh) known.delete(imageKey);
  });
  writes.set(id, settled);
  await write;
}

/** Every image key known for a conversation: the index plus a legacy ledger's refs. */
export async function readConversationImageKeys(dataRoot: string, key: string): Promise<string[]> {
  const file = conversationImagesPath(dataRoot, key);
  if (!file) return [];
  await writes.get(indexId(dataRoot, key));
  const [index, ledger] = await Promise.all([readJson(file), readJson(path.join(path.dirname(file), "ledger.json"))]);
  return [...new Set([...indexKeys(index), ...legacyLedgerKeys(ledger)])];
}

/** The conversation directory is gone (forget, thread deletion): later records write a fresh index. */
export function forgetConversationImageIndex(dataRoot: string, key: string): void {
  recorded.delete(indexId(dataRoot, key));
}
