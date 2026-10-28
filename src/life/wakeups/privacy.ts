// Which of her wakeups may show a private chat (Living cast spec §30.3, D14): one watching a DM (a DM
// among its places or its filters' places), and what a watch on "everywhere" kept or failed on (its
// code saw her DMs too). Used by the owner's views, her error wakes and her own reads of the file;
// it imports nothing heavy, so the tools can use it.

import type { WakeupSide } from "../../shared/schemas/life.js";
import { isDmPlaceKey, isDmPlaceRef } from "../dmPlaces.js";
import type { WakeupEntry } from "./file.js";

/** A wakeup watching a private chat (D14). */
export function isPrivateWakeup(entry: WakeupEntry, side: WakeupSide): boolean {
  if (entry.kind !== "watch") return false;
  const resolved = side.watches[entry.id];
  if ((resolved?.placeKeys ?? []).some((key) => isDmPlaceKey(key)) || (resolved?.filters ?? []).some((filter) => isDmPlaceKey(filter.placeKey))) return true;
  const handles = entry.places === undefined || entry.places === "everywhere" ? [] : typeof entry.places === "string" ? [entry.places] : entry.places;
  const filterPlaces = Array.isArray(entry.filter) ? entry.filter.map((filter) => filter.place) : typeof entry.filter === "object" ? [entry.filter.place] : [];
  return [...handles, ...filterPlaces].some((handle) => isDmPlaceRef(handle));
}

/** A watch on "everywhere" sees her DMs too: what its code kept or failed on may quote one. */
export function watchesEverywhere(entry: WakeupEntry): boolean {
  return entry.kind === "watch" && (entry.places === "everywhere" || entry.places === undefined);
}

/** A watch whose state may hold a private chat's words: on "everywhere" (her DMs included). */
export function stateMayBePrivate(entry: WakeupEntry): boolean {
  return watchesEverywhere(entry) && entry.state !== undefined;
}

/** Why it stopped may quote a private chat (her code's error text): a private or an everywhere watch's. */
export function disabledMayBePrivate(entry: WakeupEntry, side: WakeupSide): boolean {
  return entry.disabled !== undefined && (isPrivateWakeup(entry, side) || watchesEverywhere(entry));
}

/** Her code's runs may have seen a DM: a private watch, or one on "everywhere" (its error wake is a DM wake). */
export function mayHaveSeenDm(entry: WakeupEntry, side: WakeupSide): boolean {
  return isPrivateWakeup(entry, side) || watchesEverywhere(entry);
}

/**
 * The private chat her wakeups file shows when she reads it (D14): a private wakeup's DM (its place
 * key, else `dm_file`), or `dm_file` for an everywhere watch's state or stop reason; undefined when
 * nothing in it is private.
 */
export function wakeupsDmOrigin(entries: readonly WakeupEntry[], side: WakeupSide): string | undefined {
  for (const entry of entries) {
    if (isPrivateWakeup(entry, side)) {
      const watch = side.watches[entry.id];
      return [...(watch?.placeKeys ?? []), ...(watch?.filters ?? []).flatMap((filter) => (filter.placeKey ? [filter.placeKey] : []))].find((key) => isDmPlaceKey(key)) ?? "dm_file";
    }
  }
  return entries.some((entry) => stateMayBePrivate(entry) || disabledMayBePrivate(entry, side)) ? "dm_file" : undefined;
}
