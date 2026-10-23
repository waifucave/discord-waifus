// Prompt assembly for waifus (waifu prompt parts) and the deterministic cast. The orchestrator's
// prompt lives in orchestratorHarness.ts.

import path from "node:path";
import { modelVisibleEmojiToken } from "../discord/normalization.js";
import { type PromptBlockContext, assembleWaifuPrompt, promptTagName, reconcileWaifuPromptLayout } from "./promptBlocks.js";
import type { DeterministicCastMember } from "./deterministicOrchestrator.js";
import { resolveModelTarget, sharedRegistry } from "./pipeline/resolveTarget.js";
import {
  ActiveChatParticipant,
  GuildEmojisFileSchema,
  GuildMembersFileSchema,
  MemoryStoreSchema,
  WaifuConfig,
  createEmptyRevisionedFile
} from "../shared/schemas/domain.js";
import { resolveBotAuthorIds } from "../shared/botIdentity.js";
import { retrieveMemories } from "./memoryRetrieval.js";
import { StorageService } from "../storage/storageService.js";
import type { ContextMessage } from "./contextMessages.js";
import type { RuntimeServices } from "./runtimeShared.js";
import { readDiscordBotsFile } from "./stores/config.js";
import { emptyMemoryStore, readMemoryStore } from "./stores/memories.js";
import { readActiveChatParticipants } from "./stores/participants.js";
import { dailyIntervalContains, localTimeOfDayMinutes } from "./timeOfDay.js";

export async function buildWaifuPromptParts(
  services: Pick<RuntimeServices, "storage" | "logger" | "memory">,
  guildId: string,
  waifu: WaifuConfig,
  availableWaifus: WaifuConfig[],
  options: {
    channelId: string;
    directorNote?: string;
    pickNextWaifuToolOverride?: boolean;
    shortTermMemoryToolOverride?: boolean;
    contextMessages?: ContextMessage[];
    memoryInjectionLimit: number;
  }
): Promise<{ systemPrompt: string; midSystemBlock: string; trailingSystemBlock: string; selfGuildNickname: string | undefined }> {
  const pickNextWaifuToolActive = options.pickNextWaifuToolOverride ?? false;
  const shortTermMemoryToolActive =
    options.shortTermMemoryToolOverride ?? true;
  const [store, emojis, activeChatParticipants, members, bots] = await Promise.all([
    readMemoryStore(services.storage),
    services.storage.readJson(
      path.join("user", "servers", guildId, "emojis.json"),
      GuildEmojisFileSchema,
      GuildEmojisFileSchema.parse(createEmptyRevisionedFile({ guildId, emojis: [] }))
    ),
    readActiveChatParticipants(services.storage, guildId, options.channelId),
    services.storage.readJson(
      path.join("user", "servers", guildId, "members.json"),
      GuildMembersFileSchema,
      GuildMembersFileSchema.parse(createEmptyRevisionedFile({ guildId, members: [] }))
    ),
    readDiscordBotsFile(services.storage)
  ]);
  const now = new Date();
  const retrieval = retrieveMemories({
    records: store.memories,
    window: options.contextMessages ?? [],
    guildId,
    waifuId: waifu.id,
    channelId: options.channelId,
    now,
    limit: options.memoryInjectionLimit,
    ...(services.memory?.maxPinnedInjected !== undefined ? { maxPinned: services.memory.maxPinnedInjected } : {})
  });
  const memoryLines = retrieval.lines;
  // Stamp lastRetrievedAt on selected non-pinned records, best-effort, fire-and-forget.
  // Skip records stamped within the last hour to avoid noisy writes.
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const nowMs = now.getTime();
  const idsToStamp = retrieval.selected
    .filter(
      (r) =>
        !r.lastRetrievedAt ||
        nowMs - Date.parse(r.lastRetrievedAt) > ONE_HOUR_MS
    )
    .map((r) => r.id);
  if (idsToStamp.length > 0) {
    const stampNow = now.toISOString();
    const stampSet = new Set(idsToStamp);
    services.storage.updateRevisionedJson({
      resourceKey: "memories:global",
      relativePath: "user/memories.json",
      schema: MemoryStoreSchema,
      fallback: emptyMemoryStore(),
      transform: (current) => ({
        ...current,
        memories: current.memories.map((r) =>
          stampSet.has(r.id) ? { ...r, lastRetrievedAt: stampNow } : r
        )
      })
    }).catch((err: unknown) => {
      services.logger.warn("Failed to stamp lastRetrievedAt on retrieved memories", {
        guildId,
        waifuId: waifu.id,
        message: err instanceof Error ? err.message : String(err)
      });
    });
  }
  const emojiList = emojis.emojis
    .filter((emoji) => emoji.available)
    .map(modelVisibleEmojiToken)
    .join(" ");
  // Raw persona text; the identity block adds the identity sentence separately.
  const personalityContent = waifu.persona.trim();
  const scheduleContent = formatWaifuScheduleForPrompt(waifu);
  const waifuTag = promptTagName(waifu.name || waifu.id);
  const toolUseInstructions = buildWaifuToolUseInstructions(waifu, availableWaifus, {
    pickNextWaifu: pickNextWaifuToolActive,
    shortTermMemory: shortTermMemoryToolActive
  });
  const guildNameByUserId = new Map(
    members.members
      .filter((member) => member.guildDisplayName)
      .map((member) => [member.userId, member.guildDisplayName as string])
  );
  // members.json is keyed by the bot USER snowflake; waifu.botId is the bots-entry id.
  const guildNameForBotRef = (botIdRef: string | undefined) =>
    resolveBotAuthorIds(botIdRef, bots)
      .map((id) => guildNameByUserId.get(id))
      .find(Boolean);
  const serverNickname = guildNameForBotRef(waifu.botId);

  // Roster line: guild display names of other configured waifus with bot IDs (excluding self),
  // with the configured displayName in parentheses when the guild name differs.
  const rosterLine = availableWaifus
    .filter((candidate) => candidate.id !== waifu.id && candidate.botId)
    .map((candidate) => {
      const guildName = guildNameForBotRef(candidate.botId);
      const configured = candidate.displayName || candidate.name;
      return guildName && guildName !== configured ? `${guildName} (${configured})` : configured;
    })
    .join(", ");

  const blockContext: PromptBlockContext = {
    waifuTag,
    displayName: waifu.displayName || waifu.name || waifu.id,
    personalityContent,
    scheduleContent,
    toolUseInstructions,
    rosterLine,
    serverNickname: serverNickname !== waifu.displayName ? serverNickname : undefined,
    activeParticipantDisplayNames: channelParticipantDisplayNames(
      activeChatParticipants,
      waifu,
      availableWaifus
    ),
    emojiList,
    memoryLines,
    currentlyDoing: currentlyDoingForWaifu(waifu, new Date()),
    directorNote: options.directorNote?.trim() || undefined,
    personaDigest: waifu.personaDigest
      ? { voice: waifu.personaDigest.voice, role: waifu.personaDigest.role }
      : undefined
  };

  // The slot→string mapping is fixed; the composition of each slot is driven by the waifu's
  // editable prompt layout (see src/orchestration/promptBlocks.ts).
  return {
    ...assembleWaifuPrompt(reconcileWaifuPromptLayout(waifu.promptLayout), blockContext),
    selfGuildNickname: serverNickname !== waifu.displayName ? serverNickname : undefined
  };
}

/** Cast members + guild-nickname map for the deterministic decider and casting cards. */
export async function buildDeterministicCast(
  storage: StorageService,
  guildId: string,
  waifus: WaifuConfig[]
): Promise<{ cast: DeterministicCastMember[]; nicknames: Map<string, string> }> {
  const [bots, members] = await Promise.all([
    readDiscordBotsFile(storage),
    storage.readJson(
      path.join("user", "servers", guildId, "members.json"),
      GuildMembersFileSchema,
      GuildMembersFileSchema.parse(createEmptyRevisionedFile({ guildId, members: [] }))
    )
  ]);
  const guildNameByUserId = new Map(
    members.members
      .filter((member) => member.guildDisplayName)
      .map((member) => [member.userId, member.guildDisplayName as string])
  );
  const nicknames = new Map<string, string>();
  const cast: DeterministicCastMember[] = [];
  for (const waifu of waifus) {
    const authorIds = resolveBotAuthorIds(waifu.botId, bots);
    const nickname = authorIds.map((id) => guildNameByUserId.get(id)).find(Boolean);
    if (nickname && nickname !== waifu.displayName) nicknames.set(waifu.id, nickname);
    if (!waifu.modelId) continue; // she cannot generate a reply anyway
    const names = [...new Set([waifu.name, waifu.displayName, nickname].filter((v): v is string => Boolean(v?.trim())))];
    cast.push({ waifuId: waifu.id, names, authorIds, availability: waifu.availability });
  }
  return { cast, nicknames };
}

// Render a directive into the single-line note fed to the waifu prompt. Manual /run directions
// pass through verbatim; model intents get a parenthetical label prefix for the waifu's benefit.
// Accepts the loose stored shape (string intent, optional goal) so both the decision pipeline and
// directed-run paths can feed it without casting.
export function directiveTextForWaifu(
  directive: { intent: string; goal?: string } | undefined
): string | undefined {
  if (!directive) return undefined;
  const goal = directive.goal ?? "";
  if (directive.intent === "manual") return goal || undefined;
  return `(${directive.intent.replace(/_/g, " ")}) ${goal}`.trim();
}

function modelSupportsTools(waifu: WaifuConfig): boolean {
  if (!waifu.modelId) return false;
  try {
    const target = resolveModelTarget({ providerId: waifu.providerId, modelId: waifu.modelId });
    return sharedRegistry().resolve(target.providerId, target.modelId)?.features.tools.supported ?? false;
  } catch {
    return false;
  }
}

function buildWaifuToolUseInstructions(
  waifu: WaifuConfig,
  availableWaifus: WaifuConfig[],
  activeTools: { pickNextWaifu: boolean; shortTermMemory: boolean }
): string | undefined {
  if (!waifu.tools.toolUse) return undefined;
  if (!modelSupportsTools(waifu)) return undefined;
  const candidates = availableWaifus
    .filter((candidate) => candidate.id !== waifu.id && candidate.botId && candidate.modelId)
    .map((candidate) => `${candidate.id} (${candidate.displayName || candidate.name})`);
  const sections: string[] = [];
  if (activeTools.pickNextWaifu && candidates.length > 0) {
    sections.push(
      [
        "PickNextWaifu — only after your message, only when another waifu has an obvious immediate follow-up. Available:",
        ...candidates.map((candidate) => `- ${candidate}`)
      ].join("\n")
    );
  }
  if (activeTools.shortTermMemory) {
    sections.push(
      `add_memory — save a note whenever the chat produces something you'd want to know tomorrow (plans, promises, new facts about someone, the state of a running bit). Notes are what survives when the chat history vanishes. Skip facts already shown in <${promptTagName(waifu.name || waifu.id)}_relevant_memories>. Always also write your normal message in the same turn.`
    );
  }
  if (sections.length === 0) return undefined;
  return sections.join("\n\n");
}

function formatWaifuScheduleForPrompt(waifu: WaifuConfig): string {
  const availability = waifu.availability;
  const lines = [
    "- This is your configured routine. Treat it as background for your energy and timing, not as a live status readout.",
    "- It changes only when your schedule is edited."
  ];
  if (availability.sleep.enabled) {
    lines.push(
      `- Sleep: ${availability.sleep.start}-${availability.sleep.end} daily. This is your usual downtime, not a hard rule; you can still answer if you were just active, directly addressed, or joining helps the room.`
    );
  } else {
    lines.push("- Sleep: none configured.");
  }
  if (availability.busy.length > 0) {
    lines.push("- Busy:");
    for (const interval of availability.busy) {
      lines.push(`  - ${interval.start}-${interval.end}: ${interval.reason}`);
    }
  } else {
    lines.push("- Busy: none configured.");
  }
  return lines.join("\n");
}

export function currentlyDoingForWaifu(waifu: WaifuConfig, now: Date): string | undefined {
  const currentMinutes = localTimeOfDayMinutes(now);
  for (const interval of waifu.availability.busy) {
    if (dailyIntervalContains(currentMinutes, interval)) {
      const reason = interval.reason.trim();
      if (reason) return reason;
    }
  }
  if (waifu.availability.sleep.enabled && dailyIntervalContains(currentMinutes, waifu.availability.sleep)) {
    return "sleepy";
  }
  return undefined;
}

function channelParticipantDisplayNames(
  activeParticipants: ActiveChatParticipant[],
  self: WaifuConfig,
  availableWaifus: WaifuConfig[]
): string[] {
  const names = new Map<string, string>();
  for (const name of [
    self.displayName,
    ...availableWaifus.map((waifu) => waifu.displayName),
    ...activeParticipants.map((participant) => participant.displayName)
  ]) {
    const trimmed = name?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!names.has(key)) {
      names.set(key, trimmed);
    }
  }
  return [...names.values()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
}
