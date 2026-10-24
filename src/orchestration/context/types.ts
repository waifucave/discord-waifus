// Shared contracts of the Discord message layer kept from the Phase 4 context engine (Living cast
// spec §15 keep table): the message source, the name directory and the renderer. Model chat types
// come from winter (`@yanlinglabs/winter-provider-runtime`).

import type { ImageRef, RawDiscordMessage } from "../../shared/schemas/discordMessage.js";
import type { ConversationRef } from "./keys.js";

// Phase 4: implemented over members/emojis/roles.json + the discord.js channel cache;
// Phase 5: GuildDirectory (spec 9.4).
export type GuildDirectoryView = {
  memberName(userId: string): string | undefined;
  roleName(id: string): string | undefined;
  channelName(id: string): string | undefined;
  emoji(id: string): string | undefined;
};

export type MessageRenderer = {
  render(
    m: RawDiscordMessage,
    dir: GuildDirectoryView,
    tz: string
  ): { body: string; images: ImageRef[]; kind: "default" | "system" } | null; // null = dropped system message
};

// Phase 4: thin REST adapter; Phase 5: ConversationMessageCache (spec 9.4).
export interface ConversationMessageSource {
  // afterMessageId = id of the newest message the caller already has (null when it has none), so a
  // read only downloads what is new.
  fetchSince(i: {
    conversation: ConversationRef;
    afterMessageId: string | null;
    maxMessages: number;
    signal?: AbortSignal;
  }): Promise<{ messages: RawDiscordMessage[]; reachedCursor: boolean }>;
}
