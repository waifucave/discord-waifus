import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { useApi, useInterval } from "../api/useApi";
import type { DiscordBotConnectionStatus, DiscordBotsFile, RuntimeState, WaifusResponse } from "../api/types";
import {
  EMPTY_DRAFT,
  HOUSE_KEY,
  buildPickerEntries,
  canSave,
  connectionFor,
  connectionSettled,
  isDirty,
  saveBotDraft,
  type BotDraft,
  type BotTarget
} from "../utils/discordBots";

/** How long after a save the runtime is polled quickly, waiting for the bot to come up. */
const WATCH_MS = 40_000;

export type SaveResult = { ok: boolean; text: string };

/**
 * State behind the interactive Discord bot guide, shared by Settings and onboarding: the bots and
 * cast, the picked bot, one in-memory draft per bot, Save, and the bot's live connection status.
 * Drafts (a bot token included) live only in React state: never in storage, never logged.
 */
export function useDiscordBotSetup(options: { houseOnly?: boolean; initialKey?: string } = {}) {
  const houseOnly = options.houseOnly === true;
  const bots = useApi<DiscordBotsFile>((s) => api.discordBots(s), []);
  const waifus = useApi<WaifusResponse>(async (s) => (houseOnly ? { waifus: [] } : api.waifus(s)), [houseOnly]);
  const runtime = useApi<RuntimeState>((s) => api.runtime(s), []);

  const targets = useMemo(() => buildPickerEntries(bots.data, waifus.data?.waifus, { houseOnly }), [bots.data, waifus.data, houseOnly]);
  const [selectedKey, setSelectedKey] = useState(options.initialKey ?? HOUSE_KEY);
  const selected: BotTarget = targets.find((target) => target.key === selectedKey) ?? targets[0]!;
  const [drafts, setDrafts] = useState<Record<string, BotDraft>>({});
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<SaveResult | undefined>(undefined);
  /** When the last save finished: statuses older than this are not the answer to it. */
  const [watchSince, setWatchSince] = useState<{ key: string; at: number } | undefined>(undefined);

  const draft = drafts[selected.key] ?? EMPTY_DRAFT;
  const status: DiscordBotConnectionStatus | undefined = connectionFor(selected, runtime.data);
  const watching = watchSince !== undefined;

  useInterval(runtime.reload, watching ? 2_000 : 10_000);

  useEffect(() => {
    if (!watchSince) return;
    const stop = window.setTimeout(() => setWatchSince(undefined), WATCH_MS);
    return () => window.clearTimeout(stop);
  }, [watchSince]);

  useEffect(() => {
    if (!watchSince) return;
    const watched = targets.find((target) => target.key === watchSince.key);
    const current = watched ? connectionFor(watched, runtime.data) : undefined;
    if (current && connectionSettled(current) && Date.parse(current.updatedAt) >= watchSince.at) setWatchSince(undefined);
  }, [watchSince, runtime.data, targets]);

  const select = useCallback((key: string) => {
    setSelectedKey(key);
    setResult(undefined);
  }, []);

  const patchDraft = useCallback(
    (patch: Partial<BotDraft>) => setDrafts((all) => ({ ...all, [selected.key]: { ...(all[selected.key] ?? EMPTY_DRAFT), ...patch } })),
    [selected.key]
  );

  /** Saves the picked bot's draft. True when it saved; the message is in `result` either way. */
  const save = useCallback(async (): Promise<boolean> => {
    if (saving || !canSave(selected, draft)) return false;
    const target = selected;
    setSaving(true);
    setResult(undefined);
    try {
      const outcome = await saveBotDraft(
        {
          getBots: () => api.discordBots(),
          linkWaifuBot: (waifuId, body) => api.linkWaifuBot(waifuId, body),
          putBots: (body) => api.putDiscordBots(body),
          reload: () => api.reload()
        },
        target,
        draft
      );
      setDrafts((all) => ({ ...all, [target.key]: EMPTY_DRAFT }));
      setResult({
        ok: true,
        text: outcome.linked
          ? `${target.label} is linked to her own bot and saved — reconnecting.`
          : `${target.label} saved — reconnecting.`
      });
      setWatchSince({ key: target.key, at: Date.now() - 1_000 });
      bots.reload();
      waifus.reload();
      runtime.reload();
      return true;
    } catch (error) {
      setResult({ ok: false, text: (error as Error).message });
      // A partial failure (linked, then the write failed) changed what the picker should show.
      bots.reload();
      waifus.reload();
      return false;
    } finally {
      setSaving(false);
    }
  }, [saving, selected, draft, bots, waifus, runtime]);

  return {
    bots,
    waifus,
    runtime,
    targets,
    selected,
    select,
    draft,
    setApplicationId: (applicationId: string) => patchDraft({ applicationId }),
    setToken: (token: string) => patchDraft({ token }),
    dirty: isDirty(selected, draft),
    saveable: canSave(selected, draft),
    saving,
    save,
    result,
    clearResult: () => setResult(undefined),
    status,
    watching,
    loading: bots.loading && !bots.data,
    error: bots.error ?? waifus.error
  };
}

export type DiscordBotSetup = ReturnType<typeof useDiscordBotSetup>;
