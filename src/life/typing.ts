// "Typing…" while she works (Living cast spec §6.3): one keeper per life shows her bot typing in one
// place at a time, refreshed every 8 s (Discord clears it after about 10 s). It starts in the place of
// the wake that started the turn: at turn start for a wake meant for her (mention, name, DM, owner, the
// detector's pick), and for a looser one (watch, @everyone, a shared role) once she commits, that is
// any call but ReadMessages, from the moment it starts streaming. A send stops it; her next
// SendMessage starting to stream brings it back where she last wrote, other calls after a send don't.
// Plain text is her own thoughts and commits nothing. Never in maintenance or compaction (they never
// use a keeper; a mid-turn compaction stops it). A waifu without her own bot shows nothing; a failure
// is a warning at most once a minute and never touches the turn.

import { parseConversationKey } from "../orchestration/context/keys.js";
import type { Wake, WakeReason } from "../shared/schemas/life.js";
import type { LifeDeps } from "./deps.js";

export const TYPING_REFRESH_MS = 8_000;
const WARN_EVERY_MS = 60_000;

/** Wakes that show typing from the turn's start: someone spoke to her, the detector picked her, or the owner woke her. */
const TYPING_DIRECT: ReadonlySet<WakeReason> = new Set(["mention", "name", "dm", "owner", "detector"]);

/** The place typing would show in for a turn's wakes, and whether it starts at once. */
export function typingPlan(wakes: readonly Wake[]): { placeKey: string; immediate: boolean } | undefined {
  const first = wakes.find((wake) => wake.placeKey !== undefined && wake.reason !== "reminder" && wake.reason !== "morning");
  if (!first?.placeKey) return undefined;
  return { placeKey: first.placeKey, immediate: (first.reasons ?? [first.reason]).some((reason) => TYPING_DIRECT.has(reason)) };
}

export class TypingKeeper {
  private timer: ReturnType<typeof setInterval> | undefined;
  private placeKey: string | undefined;
  private warnedAt = -Infinity;

  constructor(
    private readonly deps: Pick<LifeDeps, "discord" | "logger" | "now">,
    private readonly waifu: { id: string; botId?: string | undefined }
  ) {}

  get active(): string | undefined {
    return this.placeKey;
  }

  /** Shows typing in `placeKey` now and keeps it alive (a no-op when it already is); typing elsewhere stops. */
  start(placeKey: string): void {
    if (this.placeKey === placeKey) return;
    this.stop();
    const place = parseConversationKey(placeKey);
    if (!place) return;
    if (place.kind === "guild" && !this.waifu.botId) return;
    if (place.kind === "dm" && place.waifuId !== this.waifu.id) return;
    this.placeKey = placeKey;
    this.send();
    this.timer = setInterval(() => this.send(), TYPING_REFRESH_MS);
    this.timer.unref?.();
  }

  /** She sent in `placeKey`: the message cleared typing there, so stop refreshing it. */
  sent(placeKey: string): void {
    if (this.placeKey === placeKey) this.stop();
  }

  /** Stops refreshing (the turn ended, was aborted, or the life stopped). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.placeKey = undefined;
  }

  private send(): void {
    const key = this.placeKey;
    const place = key ? parseConversationKey(key) : undefined;
    const discord = this.deps.discord();
    if (!place || !discord) return;
    const sending =
      place.kind === "dm"
        ? discord.sendDirectTyping?.({ waifuId: this.waifu.id, userId: place.userId })
        : discord.sendTyping({ guildId: place.guildId, channelId: place.channelId, senderBotId: this.waifu.botId! });
    void Promise.resolve(sending).catch((error: unknown) => {
      const now = this.deps.now().getTime();
      if (now - this.warnedAt < WARN_EVERY_MS) return;
      this.warnedAt = now;
      this.deps.logger.warn("Could not show typing", { category: "life", waifuId: this.waifu.id, message: error instanceof Error ? error.message : String(error) });
    });
  }
}
