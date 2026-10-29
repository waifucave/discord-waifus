// One benchmark world (spec §33.2): a fresh temp data root seeded from the scenario (her bot, her
// config, the server, her starting home), the app's own CastRuntime over the fake server, her real
// model client (or the dry-run fake), the scripted detector and the simulated clock. The real data
// root is never touched here: provider keys arrive as a lookup function and are never written.

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { redactSecrets } from "../../src/backend/redaction.js";
import type { Logger } from "../../src/backend/logger.js";
import { ensureDataLayout } from "../../src/config/layout.js";
import { checkEnvFor, homeStoreFor } from "../../src/life/home/index.js";
import { herSlug } from "../../src/life/home/pathRules.js";
import type { WebBackend } from "../../src/life/web/index.js";
import type { ProviderKeyLookup } from "../../src/models/credentials.js";
import { conversationKey } from "../../src/orchestration/context/keys.js";
import { CastRuntime } from "../../src/orchestration/runtime.js";
import { readDiscordBotsFile } from "../../src/orchestration/stores/config.js";
import { GuildDirectory } from "../../src/discord/guildDirectory.js";
import { NoopUsageLedger } from "../../src/orchestration/usageLedger.js";
import { createRevisionedBase } from "../../src/shared/schemas/common.js";
import { AppConfigSchema, DEFAULT_APP_CONFIG, type AppConfig } from "../../src/shared/schemas/config.js";
import { DiscordBotsFileSchema, ServerConfigSchema, WaifuConfigSchema, createEmptyRevisionedFile, type WaifuConfig } from "../../src/shared/schemas/domain.js";
import { StorageService } from "../../src/storage/storageService.js";
import { ScriptedDetector } from "./detector.js";
import { FakeAttachments, FakeServer, SimClock, type SentRecord } from "./fakeServer.js";
import { CapturingModelClient, MemoryLedger, dryRunPolicy, dryRunWinter, type CallRecord } from "./models.js";
import { scenarioStartMs, type MessageEvent, type Scenario } from "./scenario.js";

export const HOUSE_USER_ID = "990000000000000009";

/** A model under test: a curated route and its effort. */
export type ModelPick = { providerId: string; modelId: string; effort?: string };

export function routeId(model: ModelPick): string {
  return `${model.providerId}/${model.modelId}${model.effort ? `#${model.effort}` : ""}`;
}

export type LogNote = { at: string; level: "warn" | "error"; message: string; context?: string };

/** Warnings and errors kept for the transcript (redacted, short; nothing else is logged). */
export function recordingLogger(simNow: () => Date, sink: (note: LogNote) => void): Logger {
  const keep = (level: "warn" | "error") => (message: string, context?: unknown) => {
    const text = context === undefined ? undefined : JSON.stringify(redactSecrets(context)).slice(0, 400);
    sink({ at: simNow().toISOString(), level, message: redactSecrets(message).slice(0, 200), ...(text ? { context: text } : {}) });
  };
  return { debug: () => undefined, info: () => undefined, warn: keep("warn"), error: keep("error") };
}

/** Deep merge of plain objects (arrays and values replace). */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return (patch === undefined ? base : (patch as T));
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const current = out[key];
    out[key] = current && typeof current === "object" && !Array.isArray(current) && value && typeof value === "object" && !Array.isArray(value) ? deepMerge(current, value) : value;
  }
  return out as T;
}

/** The run's app config: the defaults, her route allowed, DMs routed per message, web off unless asked, then the scenario's own. */
export function runConfig(scenario: Scenario, model: ModelPick, o: { web: boolean }): AppConfig {
  let config: AppConfig = structuredClone(DEFAULT_APP_CONFIG);
  const route = `${model.providerId}/${model.modelId}`;
  config.models.allowed = [...new Set([...config.models.allowed, route])];
  // A DM burst is held 2.5 s of real time in the app; here every message routes at once and the
  // queue merges them into one notification entry (her turn starts only when the driver says so).
  config.discord.debounce.dmMs = 0;
  if (!o.web) {
    config.search = { ...config.search, maxPerSecond: 0, maxPerDay: 0, maxPerWaifuPerDay: 0 };
    config.life.webFetch = { ...config.life.webFetch, maxPerTurn: 0, maxPerWaifuPerDay: 0 };
  }
  config = deepMerge(config, scenario.config);
  return AppConfigSchema.parse(config);
}

/** No web at all: any search or fetch fails (web is off unless `--web`). */
const NO_WEB: WebBackend = {
  search: async () => {
    throw new Error("web is off in this benchmark run");
  },
  fetchPage: async () => {
    throw new Error("web is off in this benchmark run");
  },
  close: async () => undefined
};

export type World = {
  root: string;
  scenario: Scenario;
  waifu: WaifuConfig;
  waifuId: string;
  storage: StorageService;
  clock: SimClock;
  server: FakeServer;
  runtime: CastRuntime;
  models: CapturingModelClient;
  ledger: MemoryLedger;
  detector: ScriptedDetector;
  config: AppConfig;
  /** Scenario place (`#general`, `dm:kevin`) → the app's place key, and back. */
  placeKey(place: string): string;
  placeOf(placeKey: string): string | undefined;
  personByKey(key: string): { id: string; name: string } | undefined;
  /** Labelled and posted scenario messages by Discord id. */
  eventByMessageId: Map<string, MessageEvent>;
  messageIdByLabel: Map<string, string>;
  close(): Promise<void>;
};

export type WorldOptions = {
  scenario: Scenario;
  model: ModelPick;
  dryRun: boolean;
  web: boolean;
  /** Provider keys (live runs only), read from the real data root by the caller. */
  credentials?: ProviderKeyLookup;
  /** The sleep her own waits use (moves the simulated clock, delivering what comes in meanwhile). */
  sleep: (clock: SimClock) => (ms: number, signal?: AbortSignal) => Promise<void>;
  onCall: (call: CallRecord) => void;
  onSent: (record: SentRecord) => void;
  onLog: (note: LogNote) => void;
  /** Where temp data roots go (default: the OS temp directory). */
  tempBase?: string;
};

export async function buildWorld(o: WorldOptions): Promise<World> {
  const { scenario } = o;
  const root = await mkdtemp(path.join(o.tempBase ?? os.tmpdir(), `life-bench-${scenario.id}-`));
  await ensureDataLayout(root);
  // The layout seeds the prebuilt cast once; a benchmark world holds only the waifu under test (the
  // others would be "other people like you" in her prompt and run nightly maintenance of their own).
  await rm(path.join(root, "user", "waifus"), { recursive: true, force: true });
  await mkdir(path.join(root, "user", "waifus"), { recursive: true });
  const storage = new StorageService(root);
  const waifuDraft = { name: scenario.waifu.name };
  const waifuId = herSlug(waifuDraft);
  const botConfigId = `${waifuId}-bot`;
  const config = runConfig(scenario, o.model, { web: o.web });
  const clock = new SimClock(scenarioStartMs(scenario));

  await storage.writeJson(
    "discord-bots",
    "user/discord-bots.json",
    DiscordBotsFileSchema,
    DiscordBotsFileSchema.parse(
      createEmptyRevisionedFile({
        orchestrator: { id: "house", displayName: "House", enabled: true, applicationId: HOUSE_USER_ID },
        waifus: [{ id: botConfigId, displayName: scenario.waifu.displayName ?? scenario.waifu.name, enabled: true, applicationId: scenario.waifu.botUserId }]
      })
    )
  );
  const waifu = WaifuConfigSchema.parse({
    ...createRevisionedBase(),
    id: waifuId,
    name: scenario.waifu.name,
    displayName: scenario.waifu.displayName ?? scenario.waifu.name,
    enabled: true,
    persona: scenario.waifu.persona,
    customInstructions: scenario.waifu.style,
    model: { providerId: o.model.providerId, modelId: o.model.modelId, ...(o.model.effort ? { effort: o.model.effort } : {}) },
    botId: botConfigId,
    availability: { bedTime: scenario.waifu.bedTime ? { enabled: true, ...scenario.waifu.bedTime } : { enabled: false, start: "23:00", end: "07:00" } },
    dm: { allowDms: true, rateLimit: { maxReplies: 30, windowMinutes: 60 }, notifyWhenLimited: false, limitNotice: "", sleepNotice: "" }
  });
  await storage.writeJson(`waifu:${waifuId}`, `user/waifus/${waifuId}/waifu.json`, WaifuConfigSchema, waifu);
  if (scenario.server) {
    await storage.writeJson(
      `server:${scenario.server.id}`,
      `user/servers/${scenario.server.id}/server.json`,
      ServerConfigSchema,
      ServerConfigSchema.parse({
        ...createRevisionedBase(),
        guildId: scenario.server.id,
        name: scenario.server.name,
        channels: Object.fromEntries(scenario.server.channels.map((channel) => [channel.id, { channelId: channel.id, name: channel.key, enabledWaifuIds: channel.cast ? [waifuId] : [] }]))
      })
    );
  }

  const ledger = new MemoryLedger();
  const credentials: ProviderKeyLookup = o.dryRun ? () => "dry-run-not-a-key" : (o.credentials ?? (() => undefined));
  const models = new CapturingModelClient(
    { credentials, usageLedger: ledger, ...(o.dryRun ? { winter: dryRunWinter(dryRunPolicy(scenario)) } : {}) },
    { simNow: clock.now, record: o.onCall }
  );
  const attachments = new FakeAttachments();
  const people = scenario.people.map((person) => ({ id: person.id, name: person.name }));
  const server = new FakeServer({
    clock,
    waifuId,
    botConfigId,
    botUserId: scenario.waifu.botUserId,
    botName: scenario.waifu.displayName ?? scenario.waifu.name,
    houseUserId: HOUSE_USER_ID,
    ...(scenario.server ? { guild: { id: scenario.server.id, name: scenario.server.name, channels: scenario.server.channels.map((channel) => ({ id: channel.id, name: channel.key })) } } : {}),
    people,
    attachments,
    onSent: o.onSent
  });
  const eventByMessageId = new Map<string, MessageEvent>();
  const messageIdByLabel = new Map<string, string>();
  const detector = new ScriptedDetector({ eventOf: (id) => eventByMessageId.get(id), now: clock.now });
  const logger = recordingLogger(clock.now, o.onLog);
  // A seeded random source: the same scenario draws the same way on every run.
  let seed = 0x2f6b_1d3c;
  const random = () => {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
    return seed / 0x1_0000_0000;
  };
  // Names come from the fake server's directory snapshot; no REST transport, so nothing ever asks
  // Discord for a member (the app's default transport would use a stored bot token).
  const directory = new GuildDirectory({ storage, logger, transport: async () => undefined, settings: () => ({ memberListRefreshHours: 0 }), bots: () => readDiscordBotsFile(storage) });
  const runtime = new CastRuntime({
    storage,
    discord: server,
    logger,
    usageLedger: NoopUsageLedger,
    appConfig: config,
    models,
    images: attachments,
    directory,
    memberListRefreshHours: 0,
    livingCast: {
      now: clock.now,
      timeZone: scenario.start.timeZone,
      random,
      sleep: o.sleep(clock),
      manualScheduler: true,
      detector: detector.asDetector(),
      credentials: o.web ? credentials : () => undefined,
      ...(o.web ? {} : { webBackend: NO_WEB })
    }
  });
  await runtime.start();

  // Her starting home, through her store (every check her own writes get).
  const store = homeStoreFor(runtime.cast.deps, waifu);
  for (const [relative, content] of Object.entries(scenario.waifu.homeFiles)) {
    const target = store.resolve(`~/${relative.replace(/^~\//u, "")}`);
    if (!target.ok) throw new Error(`Scenario ${scenario.id}: home file ${relative}: ${target.error}`);
    await store.writeText(target.path, content, checkEnvFor(runtime.cast.deps, waifuId));
  }

  const keys = new Map<string, string>();
  const back = new Map<string, string>();
  for (const channel of scenario.server?.channels ?? []) {
    const key = conversationKey({ kind: "guild", guildId: scenario.server!.id, channelId: channel.id });
    keys.set(`#${channel.key}`, key);
    back.set(key, `#${channel.key}`);
  }
  for (const person of scenario.people) {
    const key = conversationKey({ kind: "dm", waifuId, userId: person.id });
    keys.set(`dm:${person.key}`, key);
    back.set(key, `dm:${person.key}`);
  }
  let closed = false;
  return {
    root,
    scenario,
    waifu,
    waifuId,
    storage,
    clock,
    server,
    runtime,
    models,
    ledger,
    detector,
    config,
    placeKey: (place) => {
      const key = keys.get(place);
      if (!key) throw new Error(`Unknown place ${place}`);
      return key;
    },
    placeOf: (key) => back.get(key),
    personByKey: (key) => people[scenario.people.findIndex((person) => person.key === key)],
    eventByMessageId,
    messageIdByLabel,
    async close() {
      if (closed) return;
      closed = true;
      await runtime.stop().catch(() => undefined);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}
