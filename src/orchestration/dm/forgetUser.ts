// The owner's forget-user, DM part (spec 9.1.4; Living cast §7.5 step 1), behind
// `POST /api/people/:userId/forget`: every DM with the user goes (`dmForget(scope: "all")` per
// waifu: DM conversation directory, DM state, cached images), then the whole `user/dms/<userId>/`
// directory including the rate-limit counters (only the owner can reset those); a fresh limits
// file keeps only the forget floor, so the old chat is never read back from Discord.
//
// Living cast L1 dropped the memory-store and conversation-ledger rewriting that used to follow:
// the stores are gone. `{userId, at}` is recorded in `user/people/forgotten.json` (§7.5 step 1) so
// L2's memories→notes migration and renderers leave the person out; the rest of the best-effort
// scrub (summary without the person, notes scrub, verification) is L2's. The usage ledger is never
// rewritten (O5).

import { rm } from "node:fs/promises";
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
};

export async function forgetUser(
  storage: StorageService,
  input: { discordUserId: string; dryRun?: boolean },
  hooks: DmForgetHooks = {}
): Promise<ForgetUserResult> {
  const { discordUserId } = input;
  const dryRun = input.dryRun === true;
  const now = (hooks.now ?? (() => new Date()))();
  // The record first: whatever fails next, L2 still leaves the person out.
  if (!dryRun) await recordForgottenPerson(storage, discordUserId, now);
  const dm = await dmForget(storage, { userId: discordUserId, scope: "all", dryRun }, hooks);
  const hasDmDir = (await listDmUserIds(storage)).includes(discordUserId);
  const dmLimits = hasDmDir ? (await listDmLimitWaifuIds(storage, discordUserId)).length : 0;
  if (!dryRun && hasDmDir) {
    await rm(storage.dataPath(dmUserDir(discordUserId)), { recursive: true, force: true });
  }
  if (!dryRun) {
    // The counters are gone, but the forget floors stay: the bot cannot delete the user's own
    // messages, so without them the next DM would read the forgotten chat back from Discord.
    const floor = dmFloorAt(now);
    for (const waifuId of dm.waifuIds) {
      await updateDmLimit(storage, discordUserId, waifuId, (current) => ({ ...current, floorMessageId: floor }));
    }
  }
  return {
    discordUserId,
    dryRun,
    dmContexts: dm.deleted.dmContexts,
    dmStates: dm.deleted.dmStates,
    dmLimits,
    cachedImages: dm.deleted.cachedImages
  };
}
