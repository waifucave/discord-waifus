import path from "node:path";
import { atomicWriteJson } from "../../storage/atomic.js";
import { isObject, nonEmptyString, readJsonOrUndefined } from "./memorySupport.js";

// Step `dream-cursor-global-v1` (spec 8.2): Phase 1's per-guild dream cursors (chunk keys per
// guild) → one global waifu round-robin cursor. The pseudo-keys "all"/"orphan" carry no waifu;
// of the remaining waifu ids the alphabetically first is kept, so the waifus after it (the ones
// least recently reached in at least one guild) are dreamed first. Idempotent.
export async function migrateDreamCursorGlobal(dataRoot: string): Promise<string | undefined> {
  const filePath = path.join(dataRoot, "user", "memory", "dream-cursor.json");
  const data = await readJsonOrUndefined(filePath);
  if (!isObject(data) || !("cursors" in data)) return undefined;
  const values = isObject(data.cursors) ? Object.values(data.cursors) : [];
  const waifuIds = values
    .map((value) => nonEmptyString(value)?.replace(/#\d+$/, ""))
    .filter((value): value is string => Boolean(value) && value !== "all" && value !== "orphan")
    .sort();
  const next: Record<string, unknown> = { ...data, cursor: typeof data.cursor === "string" ? data.cursor : (waifuIds[0] ?? null) };
  delete next.cursors;
  await atomicWriteJson(filePath, next);
  return "migrate-dream-cursor-global";
}
