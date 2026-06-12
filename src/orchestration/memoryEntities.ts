// Capitalized-token heuristic: words starting uppercase that are not sentence-initial,
// plus sentence-initial tokens repeated elsewhere in the store run. Cheap, good enough
// for retrieval boosting; the dream pass refines entities over time.
export function extractEntities(content: string): string[] {
  const tokens = content.match(/\b\p{Lu}[\p{L}\p{N}'-]*\b/gu) ?? [];
  const sentenceInitial = new Set<string>();
  for (const match of content.matchAll(/(?:^|[.!?]\s+)(\p{Lu}[\p{L}\p{N}'-]*)/gu)) {
    sentenceInitial.add(match[1]);
  }
  const frequency = new Map<string, number>();
  for (const token of tokens) {
    frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }
  const seen = new Set<string>();
  const entities: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    if (sentenceInitial.has(token) && (frequency.get(token) ?? 0) < 2) continue;
    entities.push(token);
  }
  // 8 caps stored-JSON bloat for long merged entries; short memories rarely reach it.
  return entities.slice(0, 8);
}

// Waifu-tool notes sit between ephemeral chatter and user memories; both the migration
// and the live write path must agree on this value.
export const WAIFU_NOTE_STRENGTH = 2;
