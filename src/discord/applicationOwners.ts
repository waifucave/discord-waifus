// Who may run the House bot's owner commands (`/wake`, `/print`; Living cast §10.4, owner decision
// D-a): the Discord application's owner, or the members of the team that owns it, as Discord reports
// them (`client.application.fetch()`). Server Administrator is not enough: the commands' default
// member permission (Administrator) only hides them in the Discord UI.
//
// The list is fetched when the House bot comes online, refreshed periodically, and checked again at
// run time: a check on a list older than `recheckMs` fetches first. A failed fetch keeps the last
// list (logged); with no list at all, nobody is the owner.

import type { Logger } from "../backend/logger.js";

export const OWNER_REFRESH_MS = 6 * 3_600_000;
export const OWNER_RECHECK_MS = 10 * 60_000;

/** The parts of discord.js's `ClientApplication.owner` (a `User` or a `Team`) this needs. */
export type ApplicationOwnerLike =
  | { id: string; username?: string }
  | { ownerId?: string | null; members: Iterable<[string, { id?: string; user?: { id: string }; membershipState?: number }]> | Map<string, { id?: string; user?: { id: string }; membershipState?: number }> }
  | null
  | undefined;

/** Discord's `TeamMemberMembershipState.Accepted`. */
const ACCEPTED = 2;

export function ownerIdsOf(owner: ApplicationOwnerLike): string[] {
  if (!owner) return [];
  if ("members" in owner) {
    const ids = new Set<string>();
    if (owner.ownerId) ids.add(owner.ownerId);
    for (const [key, member] of owner.members as Iterable<[string, { id?: string; user?: { id: string }; membershipState?: number }]>) {
      if (member.membershipState !== undefined && member.membershipState !== ACCEPTED) continue;
      const id = member.user?.id ?? member.id ?? key;
      if (id) ids.add(id);
    }
    return [...ids];
  }
  return owner.id ? [owner.id] : [];
}

export interface OwnerCheck {
  isOwner(userId: string): Promise<boolean>;
}

export class ApplicationOwners implements OwnerCheck {
  private ids: Set<string> | undefined;
  private fetchedAt = 0;
  private inflight: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly o: {
      fetch: () => Promise<string[]>;
      now?: () => number;
      refreshMs?: number;
      recheckMs?: number;
      logger?: Pick<Logger, "warn" | "info">;
    }
  ) {}

  private now(): number {
    return this.o.now ? this.o.now() : Date.now();
  }

  /** Fetches the owner list now (one fetch at a time). Never throws. */
  refresh(): Promise<void> {
    this.inflight ??= this.o
      .fetch()
      .then((ids) => {
        this.ids = new Set(ids);
        this.fetchedAt = this.now();
        if (ids.length === 0) this.o.logger?.warn("Discord reported no owner for the House bot's application", { category: "discord" });
      })
      .catch((error: unknown) => {
        this.o.logger?.warn("Could not fetch the House bot's application owner", { category: "discord", message: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  /** Starts the periodic refresh (an immediate one too). */
  start(): void {
    this.stop();
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.o.refreshMs ?? OWNER_REFRESH_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async isOwner(userId: string): Promise<boolean> {
    if (!this.ids || this.now() - this.fetchedAt >= (this.o.recheckMs ?? OWNER_RECHECK_MS)) await this.refresh();
    return this.ids?.has(userId) ?? false;
  }
}
