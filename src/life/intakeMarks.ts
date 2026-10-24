// Intake high-water marks (Living cast spec §5.7, review I3): per place, the newest message intake
// has already routed. Boot and resume catch-up only take messages newer than both her read cursor
// and this mark, so a message she was woken for (and chose not to read) never wakes her again after
// a restart, a reload or a reconnect. Marks are kept in memory, written at most once a second and
// on stop, in `app/intake-marks.json`; a forget drops the person's DM keys.

import { readFile } from "node:fs/promises";
import { compareIds } from "../discord/rawMessage.js";
import { atomicWriteJson } from "../storage/atomic.js";
import type { StorageService } from "../storage/storageService.js";

export const INTAKE_MARKS_PATH = ["app", "intake-marks.json"] as const;
const SAVE_DELAY_MS = 1_000;

export class IntakeMarks {
  private marks = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(private readonly storage: Pick<StorageService, "dataPath">) {}

  private get file(): string {
    return this.storage.dataPath(...INTAKE_MARKS_PATH);
  }

  /** Reads the saved marks (a missing or unreadable file is no marks: catch-up then uses the cursors). */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as { marks?: Record<string, unknown> };
      for (const [key, id] of Object.entries(parsed.marks ?? {})) {
        if (typeof id === "string" && /^\d{1,25}$/u.test(id)) this.advance(key, id, { save: false });
      }
    } catch {
      // nothing saved yet
    }
  }

  get(placeKey: string): string | undefined {
    return this.marks.get(placeKey);
  }

  /** Moves a place's mark forward (never back). */
  advance(placeKey: string, messageId: string, o: { save?: boolean } = {}): void {
    const current = this.marks.get(placeKey);
    if (current && compareIds(current, messageId) >= 0) return;
    this.marks.set(placeKey, messageId);
    if (o.save !== false) this.scheduleSave();
  }

  /** Forget: the marks of places `drop` matches (the person's DM keys). */
  drop(drop: (placeKey: string) => boolean): void {
    let changed = false;
    for (const key of [...this.marks.keys()]) {
      if (!drop(key)) continue;
      this.marks.delete(key);
      changed = true;
    }
    if (changed) this.scheduleSave();
  }

  private dirty = false;

  private scheduleSave(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, SAVE_DELAY_MS);
    this.timer.unref?.();
  }

  /** Writes the marks now (stop, tests). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.dirty) return this.saving.catch(() => undefined);
    this.dirty = false;
    const snapshot = Object.fromEntries([...this.marks.entries()].sort(([a], [b]) => a.localeCompare(b)));
    this.saving = this.saving
      .catch(() => undefined)
      .then(() => atomicWriteJson(this.file, { marks: snapshot }));
    await this.saving.catch(() => undefined);
  }
}
