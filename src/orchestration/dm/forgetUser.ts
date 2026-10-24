// The owner's forget-user, step 1 (spec 9.1.4; Living cast §7.5), behind
// `POST /api/people/:userId/forget`: every DM with the user goes (`dmForget(scope: "all")` per
// waifu: DM conversation directory, DM state, cached images), then the whole `user/dms/<userId>/`
// directory including the rate-limit counters (only the owner can reset those); a fresh limits
// file keeps only the forget floor, so the old chat is never read back from Discord.
//
// Also here, with or without a running cast: `{userId, at}` is recorded in
// `user/people/forgotten.json` (§7.5 step 1); the person leaves every server's `members.json` and
// active-chat participant lists; the Living cast archive is scrubbed whole (owner decision D-b);
// and the in-memory captured traffic (Activity, the `/api/events` replay) is cleared. The life
// scrubs (summary, other state, notes, verification) are queued by the caller before this runs.
// The usage ledger and app logs (ids only) are never rewritten (O5).

import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { scrubArchive, type ArchiveScrubResult } from "../../life/archiveScrub.js";
import { clearCapturedTraffic } from "../../shared/queryLog.js";
import { ActiveChatParticipantsFileSchema, GuildMembersFileSchema } from "../../shared/schemas/domain.js";
import type { StorageService } from "../../storage/storageService.js";
import { dmForget, type DmForgetHooks } from "./dmForget.js";
import { dmFloorAt, dmUserDir, listDmLimitWaifuIds, listDmUserIds, updateDmLimit } from "./dmStore.js";
import { recordForgottenPerson } from "./forgotten.js";

export type ForgetUserResult = {
  discordUserId: string;
  dryRun: boolean;
  /** DM conversation directories deleted. */
  dmContexts: number;
  /** DM state files deleted (rate-limit counter files are counted separately in dmLimits). */
  dmStates: number;
  dmLimits: number;
  cachedImages: number;
  /** Server member lists and active-chat participant lists the person was removed from. */
  memberLists?: number;
  /** The Living cast archive scrub (D-b): files rewritten, records removed, files left unreadable. */
  archive?: ArchiveScrubResult;
};

const SNOWFLAKE = /^\d{5,25}$/u;

async function listDir(dir: string): Promise<string[]> {
  return readdir(dir).then((names) => names.sort(), () => [] as string[]);
}

/** The person leaves every `members.json` and `active-chat-participants/<channel>.json`. */
export async function dropFromServerLists(storage: StorageService, userId: string): Promise<number> {
  let changed = 0;
  for (const guildId of await listDir(storage.dataPath("user", "servers"))) {
    if (!SNOWFLAKE.test(guildId)) continue;
    const membersPath = path.join("user", "servers", guildId, "members.json");
    const members = await storage.readJson(membersPath, GuildMembersFileSchema).catch(() => undefined);
    if (members?.members.some((member) => member.userId === userId)) {
      await storage.updateRevisionedJson({
        resourceKey: `members:${guildId}`,
        relativePath: membersPath,
        schema: GuildMembersFileSchema,
        fallback: members,
        transform: (current) => ({ ...current, members: current.members.filter((member) => member.userId !== userId) })
      });
      changed += 1;
    }
    for (const name of await listDir(storage.dataPath("user", "servers", guildId, "active-chat-participants"))) {
      if (!name.endsWith(".json")) continue;
      const channelId = name.slice(0, -".json".length);
      const relative = path.join("user", "servers", guildId, "active-chat-participants", name);
      const file = await storage.readJson(relative, ActiveChatParticipantsFileSchema).catch(() => undefined);
      if (!file?.participants.some((participant) => participant.userId === userId)) continue;
      await storage.updateRevisionedJson({
        resourceKey: `active-chat-participants:${guildId}:${channelId}`,
        relativePath: relative,
        schema: ActiveChatParticipantsFileSchema,
        fallback: file,
        transform: (current) => ({ ...current, participants: current.participants.filter((participant) => participant.userId !== userId) })
      });
      changed += 1;
    }
  }
  return changed;
}

export async function forgetUser(
  storage: StorageService,
  input: {
    discordUserId: string;
    dryRun?: boolean;
    /** Names only this person has (collected before the DM data goes): the archive scrub uses them. */
    names?: readonly string[];
    /** Names someone else has: never used to remove anything. */
    avoidNames?: readonly string[];
  },
  hooks: DmForgetHooks = {}
): Promise<ForgetUserResult> {
  const { discordUserId } = input;
  const dryRun = input.dryRun === true;
  const now = (hooks.now ?? (() => new Date()))();
  // The record first: whatever fails next, the person is still left out.
  if (!dryRun) await recordForgottenPerson(storage, discordUserId, now, hooks.logger ? { logger: hooks.logger } : {});
  const dm = await dmForget(storage, { userId: discordUserId, scope: "all", dryRun }, hooks);
  const hasDmDir = (await listDmUserIds(storage)).includes(discordUserId);
  const dmLimits = hasDmDir ? (await listDmLimitWaifuIds(storage, discordUserId)).length : 0;
  if (!dryRun && hasDmDir) {
    await rm(storage.dataPath(dmUserDir(discordUserId)), { recursive: true, force: true });
  }
  const result: ForgetUserResult = {
    discordUserId,
    dryRun,
    dmContexts: dm.deleted.dmContexts,
    dmStates: dm.deleted.dmStates,
    dmLimits,
    cachedImages: dm.deleted.cachedImages
  };
  if (dryRun) return result;
  // The counters are gone, but the forget floors stay: the bot cannot delete the user's own
  // messages, so without them the next DM would read the forgotten chat back from Discord.
  const floor = dmFloorAt(now);
  for (const waifuId of dm.waifuIds) {
    await updateDmLimit(storage, discordUserId, waifuId, (current) => ({ ...current, floorMessageId: floor }));
  }
  result.memberLists = await dropFromServerLists(storage, discordUserId);
  result.archive = await scrubArchive(storage.dataRoot, {
    userId: discordUserId,
    ...(input.names ? { names: input.names } : {}),
    ...(input.avoidNames ? { avoidNames: input.avoidNames } : {}),
    ...(hooks.logger ? { logger: hooks.logger } : {})
  });
  clearCapturedTraffic();
  return result;
}
