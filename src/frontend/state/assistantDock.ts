// Whether the assistant panel is docked open, remembered per viewer (this browser only). Storage can
// be missing or throw (private windows, blocked site data): the panel then starts closed and the
// choice simply is not remembered.

export const ASSISTANT_OPEN_KEY = "assistant-open";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function readAssistantOpen(storage: StorageLike | undefined = defaultStorage()): boolean {
  try {
    return storage?.getItem(ASSISTANT_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeAssistantOpen(open: boolean, storage: StorageLike | undefined = defaultStorage()): void {
  try {
    storage?.setItem(ASSISTANT_OPEN_KEY, open ? "1" : "0");
  } catch {
    // Not remembered; the panel still opens and closes.
  }
}

/** The shell's class: docked, the main column gives the panel its width and reflows narrower. */
export function shellClassName(assistantOpen: boolean): string {
  return assistantOpen ? "shell assistant-docked" : "shell";
}
