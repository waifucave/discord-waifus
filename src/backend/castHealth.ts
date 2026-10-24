// What needs the owner's attention in the Living cast's own state (spec §14, L2 hand-offs): migration
// steps that left unreadable data alone, owner forgets that have not finished (or were given up),
// kept copies of unreadable forget records, queued forget scrubs, and the intake marks and pause
// start. Read-only and offline: `waifus doctor` and `waifus status` read it with no host running,
// `GET /api/owner-notices` adds the live runtime's notices.

import { readFile, readdir } from "node:fs/promises";
import { resolveDataPath } from "../config/paths.js";
import { INTAKE_MARKS_PATH } from "../life/intakeMarks.js";
import { countForgetRecordCopies, readPendingScrubs } from "../orchestration/dm/forgotten.js";
import { pendingForgetJobs, pendingParts } from "../orchestration/dm/forgetUser.js";
import { listWaifus, readDiscordBotsFile } from "../orchestration/stores/config.js";
import type { StorageService } from "../storage/storageService.js";
import { readIncompleteMigrations, type IncompleteMigration } from "./migrations.js";

export type ForgetJobView = { userId: string; at: string; pending: ReturnType<typeof pendingParts> };

export type CastHealth = {
  forgetJobs: ForgetJobView[];
  incompleteMigrations: IncompleteMigration[];
  corruptForgetCopies: number;
  pendingScrubs: Array<{ waifuId: string; count: number }>;
  intake: { paused: boolean; pausedAt: string | null; marks: number };
  /** Enabled waifus linked to a bot that cannot log in for her: missing, turned off, or without a token. */
  waifusWithoutBot: Array<{ waifuId: string; reason: "bot_missing" | "bot_disabled" | "bot_no_token" }>;
};

/**
 * Enabled waifus linked to a bot that cannot log in for her, so her sends fail. (A waifu with no
 * bot linked speaks through the House bot; that is a choice, not a fault.)
 */
export async function waifusWithoutBot(storage: StorageService): Promise<CastHealth["waifusWithoutBot"]> {
  const [waifus, bots] = await Promise.all([listWaifus(storage), readDiscordBotsFile(storage)]);
  const out: CastHealth["waifusWithoutBot"] = [];
  for (const waifu of waifus) {
    if (!waifu.enabled || !waifu.botId) continue;
    const bot = bots.waifus.find((entry) => entry.id === waifu.botId);
    if (!bot) out.push({ waifuId: waifu.id, reason: "bot_missing" });
    else if (bot.enabled === false) out.push({ waifuId: waifu.id, reason: "bot_disabled" });
    else if (!bot.token) out.push({ waifuId: waifu.id, reason: "bot_no_token" });
  }
  return out;
}

const NO_BOT_TEXT: Record<CastHealth["waifusWithoutBot"][number]["reason"], string> = {
  bot_missing: "is linked to a Discord bot that is not configured",
  bot_disabled: "is linked to a Discord bot that is turned off",
  bot_no_token: "is linked to a Discord bot that has no token"
};

/** The owner-notice line for a waifu whose bot cannot log in. */
export function noBotNotice(entry: CastHealth["waifusWithoutBot"][number]): string {
  return `${entry.waifuId} ${NO_BOT_TEXT[entry.reason]}, so nothing she sends reaches Discord (Settings → Discord bots, or unlink it in Cast to speak through the House bot).`;
}

async function intakeMarks(dataRoot: string): Promise<{ pausedAt: string | null; marks: number }> {
  try {
    const parsed = JSON.parse(await readFile(resolveDataPath(dataRoot, ...INTAKE_MARKS_PATH), "utf8")) as { marks?: unknown; pausedAt?: unknown };
    const marks = parsed.marks && typeof parsed.marks === "object" ? Object.keys(parsed.marks).length : 0;
    return { pausedAt: typeof parsed.pausedAt === "string" ? parsed.pausedAt : null, marks };
  } catch {
    return { pausedAt: null, marks: 0 };
  }
}

/** Forget jobs a crash or a failure left behind, with their unfinished parts. */
export async function forgetJobViews(storage: StorageService): Promise<ForgetJobView[]> {
  return (await pendingForgetJobs(storage)).map((job) => ({ userId: job.userId, at: job.at, pending: pendingParts(job) }));
}

export async function castHealth(storage: StorageService, o: { paused: boolean }): Promise<CastHealth> {
  const waifuIds = (await readdir(resolveDataPath(storage.dataRoot, "user", "waifus")).catch(() => [] as string[])).filter((id) => !/^\.+$/u.test(id)).sort();
  const pendingScrubs: CastHealth["pendingScrubs"] = [];
  for (const waifuId of waifuIds) {
    const scrubs = await readPendingScrubs(storage, waifuId, { logger: { warn: () => undefined } }).catch(() => []);
    if (scrubs.length > 0) pendingScrubs.push({ waifuId, count: scrubs.length });
  }
  const [forgetJobs, incompleteMigrations, corruptForgetCopies, marks, withoutBot] = await Promise.all([
    forgetJobViews(storage).catch(() => [] as ForgetJobView[]),
    readIncompleteMigrations(storage.dataRoot),
    countForgetRecordCopies(storage.dataRoot).catch(() => 0),
    intakeMarks(storage.dataRoot),
    waifusWithoutBot(storage).catch(() => [] as CastHealth["waifusWithoutBot"])
  ]);
  return { forgetJobs, incompleteMigrations, corruptForgetCopies, pendingScrubs, intake: { paused: o.paused, ...marks }, waifusWithoutBot: withoutBot };
}
