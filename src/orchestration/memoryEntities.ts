// Capitalized-token heuristic: words starting uppercase that are not sentence-initial,
// plus sentence-initial tokens repeated elsewhere in the store run. Cheap, good enough
// for retrieval boosting; the dream pass refines entities over time.
export function extractEntities(content: string): string[] {
  const tokens = content.match(/\b\p{Lu}[\p{L}\p{N}'-]*\b/gu) ?? [];
  const sentenceInitial = new Set<string>();
  for (const match of content.matchAll(/(?:^|[.!?]\s+)(\p{Lu}[\p{L}\p{N}'-]*)/gu)) {
    sentenceInitial.add(match[1]);
  }
  const seen = new Set<string>();
  const entities: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    if (sentenceInitial.has(token) && tokens.filter((t) => t === token).length < 2) continue;
    entities.push(token);
  }
  return entities.slice(0, 8);
}
