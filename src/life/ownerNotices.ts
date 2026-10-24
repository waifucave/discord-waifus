// Notices for the owner from the Living cast (shown in `/api/runtime` `discord.warnings` next to
// the permission warnings): one line per key, replaced when it changes and cleared when the cause
// goes away. In memory only: each cause is re-detected after a restart.

export class OwnerNotices {
  private readonly notices = new Map<string, string>();

  set(key: string, text: string): void {
    this.notices.set(key, text);
  }

  clear(key: string): void {
    this.notices.delete(key);
  }

  list(): string[] {
    return [...this.notices.values()];
  }
}

export const FORGET_RECORDS_NOTICE = "forget-records";
export const FORGET_RECORDS_UNREADABLE =
  "user/people/forgotten.json is unreadable: message previews are hidden and the addressee detector is off until it is repaired (the next forget-user rewrites it from what can still be read).";
