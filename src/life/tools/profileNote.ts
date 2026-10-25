// What she is told after she changes `~/profile.json` (spec §17.1): when Discord will show it, and
// that a rate-limited username change is already on its way (so she does not rename again). Starts
// the profile sync. Also: her profile is not changed while she tidies (maintenance).

import { discordProfileStatus } from "../../discord/profileSync.js";
import type { LifeDeps } from "../deps.js";
import { PROFILE_FILE } from "../home/pathRules.js";

export const PROFILE_TIDY_REFUSED = `error: ${PROFILE_FILE} isn't changed while tidying; leave it as it is`;

const LABEL: Record<string, string> = { username: "username", avatar: "avatar", banner: "banner", bio: "bio", nickname: "nickname" };

function minutesUntil(iso: string, now: Date): number {
  return Math.max(1, Math.ceil((Date.parse(iso) - now.getTime()) / 60_000));
}

function list(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** The sentence after "saved" for a profile change; starts the sync. */
export async function profileSavedNote(deps: Pick<LifeDeps, "storage" | "discord" | "now" | "profileSync" | "logger">, waifuId: string, changed: boolean): Promise<string> {
  if (!changed) return "your profile is the same as before";
  const now = deps.now();
  const status = await discordProfileStatus({
    storage: deps.storage,
    waifuId,
    handleFor: (botId) => deps.discord()?.waifuBotProfile?.(botId),
    now: now.getTime()
  }).catch(() => undefined);
  void deps.profileSync?.syncWaifu(waifuId).catch((error: unknown) => {
    deps.logger.warn("Discord profile sync failed", { waifuId, message: error instanceof Error ? error.message : String(error) });
  });
  if (!status) return "saved";
  switch (status.state) {
    case "no_bot":
    case "bot_missing":
      return "saved; you don't have a Discord account of your own yet, so nobody sees it until you do";
    case "shared_bot":
      return "saved; your Discord account is shared, so Discord keeps showing what it shows now";
    case "offline":
      return "saved; Discord shows it once you're back online";
    default:
      break;
  }
  const parts: string[] = [];
  const username = status.retryAfterByField["username"];
  if (status.pendingFields.includes("username") && username) {
    parts.push(`Discord allows only about 2 username changes an hour, so your new username shows in ~${minutesUntil(username, now)} min; it's already on its way, don't change it again before then`);
  }
  const soon = status.pendingFields.filter((field) => !status.retryAfterByField[field]).map((field) => LABEL[field] ?? field);
  const waiting = status.pendingFields.filter((field) => field !== "username" && status.retryAfterByField[field]).map((field) => LABEL[field] ?? field);
  if (soon.length > 0) parts.push(`Discord will show the new ${list(soon)} shortly`);
  if (waiting.length > 0) parts.push(`Discord is busy; your ${list(waiting)} follows in a while`);
  for (const warning of status.warnings) {
    if (warning.code === "missing_permission") parts.push("one server doesn't let you change your nickname there");
    if (warning.code === "not_in_server") parts.push("you aren't in one of those servers, so that nickname waits");
  }
  if (parts.length === 0) return "saved; Discord already shows it";
  return `saved; ${[...new Set(parts)].join("; ")}`;
}
