// Her wakeups in the owner's views (Living cast spec §30.3, D14): the dashboard, the API, the
// assistant and `waifus wakeups` show each wakeup with its source. A wakeup watching a private chat
// (a DM among its places or its filters' places) is a private entry: without a local
// `includePrivate` its note, places, filter, state and stop reason read `[private chat redacted]`. A
// watch on "everywhere" sees her DMs too, so its state (what her code remembered) and its stop reason
// (her code's error) are redacted the same way (`privacy.ts`).

import { PRIVATE_FILE_NAME } from "../../shared/constants/files.js";
import type { WakeupSide } from "../../shared/schemas/life.js";
import { isDmPlaceKey, isDmPlaceRef } from "../dmPlaces.js";
import { readsWhole, wakeupsText, type WakeupEntry } from "./file.js";
import { nextTimes } from "./schedule.js";
import { disabledMayBePrivate, isPrivateWakeup, stateMayBePrivate } from "./privacy.js";
import { localMinute } from "./when.js";

export { isPrivateWakeup, mayHaveSeenDm, wakeupsDmOrigin } from "./privacy.js";

/** One wakeup as the owner sees it. */
export function wakeupView(entry: WakeupEntry, side: WakeupSide, o: { includePrivate: boolean; timeZone: string; now: Date }) {
  const isPrivate = isPrivateWakeup(entry, side);
  const hide = isPrivate && !o.includePrivate;
  const hideState = !o.includePrivate && (isPrivate || stateMayBePrivate(entry));
  const hideDisabled = !o.includePrivate && disabledMayBePrivate(entry, side);
  const next = entry.kind === "every" ? nextTimes(entry, o.now, o.timeZone).map((date) => localMinute(date, o.timeZone)) : [];
  return {
    id: entry.id,
    kind: entry.kind,
    ...(entry.when !== undefined ? { when: entry.when } : {}),
    ...(next.length > 0 ? { next } : {}),
    ...(entry.places !== undefined ? { places: hide ? PRIVATE_FILE_NAME : entry.places } : {}),
    ...(entry.filter !== undefined ? { filter: hide ? PRIVATE_FILE_NAME : entry.filter } : {}),
    ...(entry.url !== undefined ? { url: entry.url } : {}),
    ...(entry.check !== undefined ? { check: entry.check } : {}),
    ...(entry.options !== undefined ? { options: entry.options } : {}),
    note: hide ? PRIVATE_FILE_NAME : entry.note,
    ...(entry.state !== undefined ? { state: hideState ? PRIVATE_FILE_NAME : entry.state } : {}),
    ...(entry.disabled !== undefined ? { disabled: hideDisabled ? PRIVATE_FILE_NAME : entry.disabled } : {}),
    ...(isPrivate ? { private: true as const } : {})
  };
}

/**
 * Her wakeups.json as the owner may read it without `includePrivate`: undefined when nothing in it is
 * private, the redacted copy otherwise, or "refuse" when the file does not read whole and might hold
 * a private chat.
 */
export function redactedWakeupsText(text: string, entries: readonly WakeupEntry[], side: WakeupSide): string | "refuse" | undefined {
  const sensitive = entries.some((entry) => isPrivateWakeup(entry, side) || stateMayBePrivate(entry) || disabledMayBePrivate(entry, side));
  if (!readsWhole(text, entries.length)) {
    const mayHoldDm = sensitive || isDmPlaceRef(text) || /"everywhere"/u.test(text) || Object.values(side.watches).some((watch) => (watch.placeKeys ?? []).some((key) => isDmPlaceKey(key)));
    return mayHoldDm ? "refuse" : undefined;
  }
  if (!sensitive) return undefined;
  return wakeupsText(
    entries.map((entry) => {
      const isPrivate = isPrivateWakeup(entry, side);
      return {
        ...entry,
        ...(isPrivate ? { note: PRIVATE_FILE_NAME, ...(entry.places !== undefined ? { places: PRIVATE_FILE_NAME } : {}), ...(entry.filter !== undefined ? { filter: PRIVATE_FILE_NAME } : {}) } : {}),
        ...(entry.state !== undefined && (isPrivate || stateMayBePrivate(entry)) ? { state: { redacted: PRIVATE_FILE_NAME } } : {}),
        ...(disabledMayBePrivate(entry, side) ? { disabled: PRIVATE_FILE_NAME } : {})
      };
    })
  );
}
