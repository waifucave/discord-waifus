// Memory store reads and the waifu add_memory note writer.

import { randomUUID } from "node:crypto";
import { MemoryRecord, MemoryStore, MemoryStoreSchema, createEmptyRevisionedFile } from "../../shared/schemas/domain.js";
import { WAIFU_NOTE_STRENGTH, extractEntities } from "../memoryEntities.js";
import { StorageService } from "../../storage/storageService.js";

export function emptyMemoryStore(): MemoryStore {
  return MemoryStoreSchema.parse(createEmptyRevisionedFile({ memories: [] }));
}

export async function readMemoryStore(storage: StorageService): Promise<MemoryStore> {
  return storage.readJson("user/memories.json", MemoryStoreSchema, emptyMemoryStore());
}

// Waifu notes (formerly the short-term store) survive a weekend so a Friday plan is still around
// Monday; the dream pass promotes the keepers.
const NOTE_LIFESPAN_MS = 72 * 60 * 60 * 1000;
const NOTE_MAX_PER_REPLY = 5;

function normalizeNoteContent(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
}

export async function recordWaifuNotes(storage: StorageService, input: {
  guildId: string;
  channelId: string;
  waifuId: string;
  entries: string[];
}): Promise<void> {
  if (input.entries.length === 0) return;
  const capped = input.entries.slice(0, NOTE_MAX_PER_REPLY);
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + NOTE_LIFESPAN_MS).toISOString();
  await storage.updateRevisionedJson({
    resourceKey: "memories:global",
    relativePath: "user/memories.json",
    schema: MemoryStoreSchema,
    fallback: emptyMemoryStore(),
    transform: (current) => {
      // Dedup against notes already stored for this waifu in this channel —
      // the model frequently re-records the same fact on a later turn.
      const existingForScope = new Set(
        current.memories
          .filter(
            (memory) =>
              memory.source === "waifu_tool" &&
              memory.status === "active" &&
              memory.guildId === input.guildId &&
              memory.channelId === input.channelId &&
              memory.waifuId === input.waifuId &&
              (!memory.expiresAt || Date.parse(memory.expiresAt) > now)
          )
          .map((memory) => normalizeNoteContent(memory.content))
      );
      const additions: MemoryRecord[] = [];
      for (const content of capped) {
        const key = normalizeNoteContent(content);
        if (!key || existingForScope.has(key)) continue;
        existingForScope.add(key);
        additions.push({
          id: randomUUID(),
          guildId: input.guildId,
          channelId: input.channelId,
          waifuId: input.waifuId,
          content,
          kind: "context",
          source: "waifu_tool",
          pinned: false,
          strength: WAIFU_NOTE_STRENGTH,
          entities: extractEntities(content),
          expiresAt,
          createdAt,
          updatedAt: createdAt,
          status: "active"
        });
      }
      return { ...current, memories: [...current.memories, ...additions] };
    }
  });
}
