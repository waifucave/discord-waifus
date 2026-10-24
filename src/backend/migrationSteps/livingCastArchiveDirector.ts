// Step `living-cast-archive-director-v1` (Living cast spec §11.2): the retired director's data moves
// to `user/.archive/living-cast/`:
//
// - `user/orchestrator/`, `user/stage-manager/`, `user/reviewer/` (configs and histories);
// - per guild, `user/servers/<guildId>/orchestrator-history.json` (and any stage-manager or reviewer
//   history there) and `sessions/` → `servers/<guildId>/…`;
// - per conversation, the context engine's `user/conversations/<key>/ledger.json` and `contexts/` →
//   `conversations/<key>/…`; the ref store (`refs.json`) and the image index stay. A ledger's image
//   refs are first folded into the conversation's `images.json`, so a later forget still purges
//   those cached images and OCR text.
//
// Shutdown-persisted wakes in old session files are not converted. Idempotent: whatever already
// moved is gone from its source, so a re-run moves nothing.

import { appendFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "../../storage/atomic.js";
import { CONVERSATION_IMAGE_INDEX_FILE, CONVERSATION_IMAGE_OVERFLOW_FILE, MAX_INDEXED_KEYS } from "../../discord/imageIndex.js";
import { moveInto, archivePath } from "./livingCastArchive.js";
import { isObject, readJsonOrUndefined } from "./memorySupport.js";

const AGENT_DIRS = ["orchestrator", "stage-manager", "reviewer"];
const GUILD_FILES = ["orchestrator-history.json", "stage-manager-history.json", "reviewer-history.json", "sessions"];
const CONVERSATION_ENTRIES = ["ledger.json", "contexts"];
const SAFE_NAME = /^[A-Za-z0-9._:-]+$/;

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && SAFE_NAME.test(entry.name) && !/^\.+$/u.test(entry.name)).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Image keys of a context-engine ledger (`entries[*].images[].key`). */
function ledgerImageKeys(ledger: unknown): string[] {
  if (!isObject(ledger) || !isObject(ledger.entries)) return [];
  const keys: string[] = [];
  for (const entry of Object.values(ledger.entries)) {
    const images = isObject(entry) && Array.isArray(entry.images) ? entry.images : [];
    for (const image of images) if (isObject(image) && typeof image.key === "string" && image.key.length > 0) keys.push(image.key);
  }
  return keys;
}

/** Adds a ledger's image keys to the conversation's `images.json` (keys already there stay first). */
async function foldLedgerImages(conversationDir: string): Promise<void> {
  const ledgerKeys = ledgerImageKeys(await readJsonOrUndefined(path.join(conversationDir, "ledger.json")));
  if (ledgerKeys.length === 0) return;
  const indexFile = path.join(conversationDir, CONVERSATION_IMAGE_INDEX_FILE);
  const index = await readJsonOrUndefined(indexFile);
  const existing = isObject(index) && Array.isArray(index.keys) ? index.keys.filter((key): key is string => typeof key === "string") : [];
  const merged = [...new Set([...existing, ...ledgerKeys])];
  if (merged.length === existing.length) return;
  // Past the index cap the oldest keys go to the append-only overflow file first, never dropped.
  const overflow = merged.length > MAX_INDEXED_KEYS ? merged.slice(0, merged.length - MAX_INDEXED_KEYS) : [];
  if (overflow.length > 0) await appendFile(path.join(conversationDir, CONVERSATION_IMAGE_OVERFLOW_FILE), `${overflow.join("\n")}\n`, { mode: 0o600 });
  await atomicWriteJson(indexFile, { keys: merged.slice(merged.length - Math.min(merged.length, MAX_INDEXED_KEYS)) });
}

export async function migrateLivingCastArchiveDirector(dataRoot: string): Promise<string | undefined> {
  let moved = 0;
  for (const name of AGENT_DIRS) {
    if (await moveInto(path.join(dataRoot, "user", name), archivePath(dataRoot, name))) moved += 1;
  }
  for (const guildId of await listDirs(path.join(dataRoot, "user", "servers"))) {
    for (const name of GUILD_FILES) {
      if (await moveInto(path.join(dataRoot, "user", "servers", guildId, name), archivePath(dataRoot, "servers", guildId, name))) moved += 1;
    }
  }
  for (const key of await listDirs(path.join(dataRoot, "user", "conversations"))) {
    const dir = path.join(dataRoot, "user", "conversations", key);
    if (await stat(path.join(dir, "ledger.json")).then(() => true, () => false)) await foldLedgerImages(dir);
    for (const name of CONVERSATION_ENTRIES) {
      if (await moveInto(path.join(dir, name), archivePath(dataRoot, "conversations", key, name))) moved += 1;
    }
  }
  return moved > 0 ? `living-cast-archive-director-${moved}` : undefined;
}
