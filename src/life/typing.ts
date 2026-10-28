// "Typing…" while she writes (Living cast spec §6.3): her bot shows typing only where a message is
// on its way. Reading, notes, Bash and searches show nothing. As a SendMessage call streams, its
// `place` is picked out of the arguments as soon as it is complete and typing starts there, before
// the text has finished streaming; the send itself clears it on Discord and the keeper stops
// refreshing. One place at a time, refreshed every 8 s (Discord clears it after about 10 s). Never
// in maintenance or compaction (they never use a keeper; a mid-turn compaction stops it). A waifu
// without her own bot shows nothing; a failure is a warning at most once a minute and never touches
// the turn.

import { parseConversationKey } from "../orchestration/context/keys.js";
import type { LifeDeps } from "./deps.js";

export const TYPING_REFRESH_MS = 8_000;
const WARN_EVERY_MS = 60_000;

/**
 * The `place` of a streaming SendMessage, once its string is complete in the arguments JSON so far
 * (undefined until then). Since §32 the place is inside her script (`tools.send_message({ place:
 * "bake-club/#general", …`): the script string so far is decoded and its first `place: "…"` read;
 * a top-level `"place": "…"` pair (a call from before) still counts. The text that may follow is
 * never needed.
 */
export function streamedPlace(argumentsJson: string): string | undefined {
  const match = /"place"\s*:\s*"((?:[^"\\]|\\.)*)"/u.exec(argumentsJson);
  if (match) return decoded(match[1]!);
  const script = /"script"\s*:\s*"((?:[^"\\]|\\.)*)/u.exec(argumentsJson);
  if (!script) return undefined;
  // Her script so far, its JSON escapes undone (an escape cut off at the end is left out).
  const text = decoded(script[1]!.replace(/\\(?:u[0-9a-fA-F]{0,3})?$/u, ""));
  if (text === undefined) return undefined;
  const call = text.indexOf("send_message");
  if (call < 0) return undefined;
  const place = /\bplace\s*:\s*(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/u.exec(text.slice(call));
  const value = place?.[2]?.trim();
  return value ? value : undefined;
}

function decoded(raw: string): string | undefined {
  try {
    const value = JSON.parse(`"${raw}"`) as string;
    return value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
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
