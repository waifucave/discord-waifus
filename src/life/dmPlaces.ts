// What names a private chat (D14): a place argument or text (`dm/kevin`, `dm_<key>`) and a resolved
// place key. Kept apart (no imports) so the tools and her wakeups can use it without loading the
// owner's views.

/** A place argument (or any string input) that names a DM: `dm/kevin`, ` DM/Kevin `, `<dm/kevin>`, `dm_<key>`. */
export function isDmPlaceRef(value: unknown): boolean {
  // Up to a SendMessage script's size (§27: 40,000 characters).
  return typeof value === "string" && value.length <= 40_000 && /dm[/_]/iu.test(value);
}

/** A placeKey a tool resolved to: a DM conversation (`dm_<user>_<waifu>`). */
export function isDmPlaceKey(placeKey: string | undefined): boolean {
  return typeof placeKey === "string" && placeKey.startsWith("dm_");
}
