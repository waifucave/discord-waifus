// Shared prompt helpers: the deterministic cast, directive text and "currently doing". The waifu
// prompt lives in waifuHarness.ts (context engine, spec 8.5); the orchestrator's in
// orchestratorHarness.ts.

import path from "node:path";
import type { DeterministicCastMember } from "./deterministicOrchestrator.js";
import { GuildMembersFileSchema, WaifuConfig, createEmptyRevisionedFile } from "../shared/schemas/domain.js";
import { resolveBotAuthorIds } from "../shared/botIdentity.js";
import { StorageService } from "../storage/storageService.js";
import { readDiscordBotsFile } from "./stores/config.js";
import { dailyIntervalContains, localTimeOfDayMinutes } from "./timeOfDay.js";

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
