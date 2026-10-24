import { sharedUsageLedger } from "../orchestration/usageLedger.js";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { loadAppConfig } from "../config/appConfig.js";
import { appDataPath } from "../config/paths.js";
import { readPackageVersion } from "../config/layout.js";
import { atomicWriteJson } from "../storage/atomic.js";
import { StorageService } from "../storage/storageService.js";
import { acquireHostInstanceLock } from "../storage/instanceLock.js";
import {
  DiscordConnectError,
  DiscordGatewayFacade,
  DiscordJsGateway,
  DiscordJsGatewayOptions,
  DiscordRuntimeIssue,
  DiscordRuntimeStatus
} from "../discord/client.js";
import { mergeConfiguredBotsIntoMembers } from "../discord/memberCache.js";
import { GuildDirectory } from "../discord/guildDirectory.js";
import { listWaifus, readDiscordBotsFile } from "../orchestration/stores/config.js";
import { computeDmEligibility } from "../orchestration/dm/dmStore.js";
import { CastRuntime } from "../orchestration/runtime.js";
import { ImageOcrService } from "../orchestration/ocr.js";
import { DiscordImageFetcher, sharedImageFetcherConfig } from "../discord/attachments.js";
import {
  DiscordBotsFileSchema,
  GuildEmojisFileSchema,
  GuildMembersFileSchema,
  GuildRolesFileSchema,
  createEmptyRevisionedFile
} from "../shared/schemas/domain.js";
import { createApiServer, resolveStaticDir } from "../api/server.js";
import { createLogger, Logger } from "./logger.js";
import { runMigrations } from "./migrations.js";
import { RuntimeState, createRuntimeState } from "./runtime.js";
import {
  RemoteAccessService,
  type HelperSupervisorController,
  type ResolvedRemoteDashboard
} from "./remoteAccess/remoteAccessService.js";
import { RemoteRequestBridge } from "./remoteAccess/requestBridge.js";
import { createHostHelperSupervisor } from "./remoteAccess/hostHelperSupervisor.js";
import { remoteRolePaths } from "../remote/paths.js";
import { DashboardBuild } from "./remoteAccess/dashboardBuild.js";
import { UpdateActivity } from "./updates/activity.js";
import { registerAutomaticUpdates } from "./updates/control.js";

export type StartBackendOptions = {
  dataRoot: string;
  port?: number;
  host?: string;
  mode?: "start" | "dev" | "test";
  logger?: Logger;
  createDiscordGateway?: (options: DiscordJsGatewayOptions) => DiscordGatewayFacade;
  discordRetryDelaysMs?: number[];
  /** Internal dependency hooks used by helper packaging and lifecycle tests. */
  remoteAccess?: {
    supervisor?: HelperSupervisorController;
    dashboard?: ResolvedRemoteDashboard;
    dashboardBuild?: DashboardBuild;
  };
};

export type RunningBackend = {
  url: string;
  runtime: RuntimeState;
  remoteAccess: RemoteAccessService;
  close: () => Promise<void>;
};

const DEFAULT_DISCORD_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000] as const;

// B21: hold the data root's exclusive host lock for the backend's whole lifetime, before any
// migration, updater registration or Discord login can run; refuse to start if it is held.
export async function startBackend(options: StartBackendOptions): Promise<RunningBackend> {
  const instanceLock = await acquireHostInstanceLock(options.dataRoot);
  let running: RunningBackend;
  try {
    running = await startLockedBackend(options);
  } catch (error) {
    await instanceLock.release();
    throw error;
  }
  return {
    ...running,
    close: async () => {
      try {
        await running.close();
      } finally {
        await instanceLock.release();
      }
    }
  };
}

async function startLockedBackend(options: StartBackendOptions): Promise<RunningBackend> {
  const updateActivity = new UpdateActivity();
  let updateReady = false;
  let updateClosing = false;
  let updateReloads = 0;
  let updateBusy: () => boolean = () => true;
  let updateNeedsCredentials: () => boolean = () => true;
  const updater = await registerAutomaticUpdates({
    activity: updateActivity, dataRoot: options.dataRoot, role: "host",
    version: await readPackageVersion(),
    args: ["start", "--data-root", options.dataRoot,
      ...(options.port ? ["--port", String(options.port)] : []),
      ...(options.host ? ["--host", options.host] : [])],
    busy: () => (options.mode !== undefined && options.mode !== "start") || !updateReady || updateClosing || updateReloads > 0 || updateBusy(),
    requiresCredentials: () => updateNeedsCredentials()
  });
  try {
    const migrations = await runMigrations(options.dataRoot);
    const config = await loadAppConfig(options.dataRoot);
    const packageVersion = await readPackageVersion();
    const port = options.port ?? config.http.port;
    const host = options.host ?? config.http.host;
    const logger = options.logger ?? createLogger({ dataRoot: options.dataRoot });
    for (const step of migrations.incomplete) logger.warn("A migration step left unreadable data alone; it runs again at the next start", { step });
    const storage = new StorageService(options.dataRoot, {
      onLockWait: (resourceKey, waitMs) => logger.warn("Storage lock wait exceeded threshold", { resourceKey, waitMs })
    });
    const runtime = createRuntimeState({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      packageVersion,
      port,
      dataRoot: options.dataRoot,
      mode: options.mode ?? "start",
      paused: config.runtime.paused,
      discord: offlineDiscordStatus(),
      queues: {
        active: 0,
        configuredGuilds: await countConfiguredGuilds(storage)
      }
    });
    const dashboardResolution = options.remoteAccess?.dashboard
      ? {
          dashboard: options.remoteAccess.dashboard,
          ...(options.remoteAccess.dashboardBuild
            ? { build: options.remoteAccess.dashboardBuild }
            : {})
        }
      : await resolveRemoteDashboard(config.frontend.staticDir, logger);
    const dashboard = dashboardResolution.dashboard;
    // Remote Access is optional: an unsupported platform or unusable compatibility table
    // yields a fail-closed supervisor that reports why, never a failed host boot.
    const helperSupervisor = options.remoteAccess?.supervisor
      ?? await createHostHelperSupervisor({
        role: "host",
        dataRoot: options.dataRoot,
        appVersion: packageVersion,
        buildId: dashboard.buildId,
        logger: createLogger({ logFile: remoteRolePaths(options.dataRoot, "host").log })
      });
    const remoteAccess = new RemoteAccessService({
      dataRoot: options.dataRoot,
      runtime,
      effectiveHost: host,
      dashboard,
      supervisor: helperSupervisor
    });

    // One directory for the host (spec 9.4): the runtime keeps it fresh from gateway events, the
    // dashboard's refresh buttons and the periodic member list refresh go through it too.
    let memberListRefreshHours = config.discord.memberListRefreshHours;
    const directory = new GuildDirectory({
      storage,
      logger,
      settings: () => ({ memberListRefreshHours }),
      bots: () => readDiscordBotsFile(storage)
    });

    const createDiscordGateway =
      options.createDiscordGateway ??
      ((gatewayOptions: DiscordJsGatewayOptions) => new DiscordJsGateway(gatewayOptions));
    const discordRetryDelaysMs = options.discordRetryDelaysMs?.length
      ? options.discordRetryDelaysMs
      : [...DEFAULT_DISCORD_RETRY_DELAYS_MS];

    let gateway: DiscordGatewayFacade | undefined;
    let castRuntime: CastRuntime | undefined;
    let discordRetryTimer: NodeJS.Timeout | undefined;
    let discordRetryAttempt = 0;
    let discordRecoveryInProgress = false;
    let pendingLiveDiscordErrorMessage: string | undefined;
    let closing = false;
    let enqueueReloadRuntime: (reason: string, retryOptions?: { scheduledRetry?: boolean }) => Promise<void>;

    const cleanupOcr = async (currentConfig = config) => {
      const ocr = new ImageOcrService({
        dataRoot: options.dataRoot,
        config: currentConfig.ocr,
        logger
      });
      await ocr.cleanupExpired().catch((error) => {
        logger.warn("OCR cleanup failed", { message: error instanceof Error ? error.message : String(error) });
      });
    };

    const makeCastRuntime = (nextGateway: DiscordGatewayFacade, currentConfig = config) => {
      memberListRefreshHours = currentConfig.discord.memberListRefreshHours;
      // One image fetcher shared by OCR and the context engine's inline images (spec 8.4).
      const images = new DiscordImageFetcher({
        dataRoot: options.dataRoot,
        logger,
        config: sharedImageFetcherConfig(currentConfig, logger)
      });
      const ocr = new ImageOcrService({
        dataRoot: options.dataRoot,
        config: currentConfig.ocr,
        logger,
        fetcher: images
      });
      return new CastRuntime({
        storage,
        discord: nextGateway,
        logger,
        ocr,
        images,
        directory,
        memberListRefreshHours: currentConfig.discord.memberListRefreshHours,
        appConfig: currentConfig,
        updateActivity,
        isPaused: () => runtime.paused || closing,
        onActiveRunsChange: (activeRuns) => {
          runtime.queues.active = activeRuns;
          runtime.updatedAt = new Date().toISOString();
        }
      });
    };

    const clearDiscordRetry = () => {
      if (discordRetryTimer) {
        clearTimeout(discordRetryTimer);
        discordRetryTimer = undefined;
      }
    };

    const nextDiscordRetryDelayMs = (attempt: number) =>
      discordRetryDelaysMs[Math.min(attempt - 1, discordRetryDelaysMs.length - 1)] ??
      DEFAULT_DISCORD_RETRY_DELAYS_MS[0];

    const scheduleDiscordRetry = async (
      message: string,
      retryOptions: {
        preserveExistingTimer?: boolean;
        failureLabel?: string;
        logReason?: string;
      } = {}
    ) => {
      if (closing) return;
      const failureLabel = retryOptions.failureLabel ?? "Discord auto-connect failed";
      if (retryOptions.preserveExistingTimer && discordRetryTimer) {
        const lastErrorAt = new Date().toISOString();
        const attempt = Math.max(discordRetryAttempt, 1);
        const nextRetryAt = runtime.discord.nextRetryAt ??
          new Date(Date.now() + nextDiscordRetryDelayMs(attempt)).toISOString();
        runtime.discord = {
          ...withoutDiscordConnecting(runtime.discord),
          connected: false,
          houseConnected: false,
          waifuBotCount: 0,
          retrying: true,
          retryAttempt: attempt,
          nextRetryAt,
          lastError: message,
          lastErrorAt,
          warnings: [
            `${failureLabel}: ${message}`,
            `Discord auto-connect will retry automatically at ${nextRetryAt}.`
          ]
        };
        runtime.updatedAt = new Date().toISOString();
        await writeRuntimeFiles(options.dataRoot, runtime);
        logger.warn("Discord auto-connect retry already pending; updated latest error", {
          attempt: runtime.discord.retryAttempt,
          nextRetryAt,
          message,
          reason: retryOptions.logReason
        });
        return;
      }
      clearDiscordRetry();
      discordRetryAttempt += 1;
      const lastErrorAt = new Date().toISOString();
      const delayMs = nextDiscordRetryDelayMs(discordRetryAttempt);
      const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
      runtime.discord = {
        ...withoutDiscordConnecting(runtime.discord),
        connected: false,
        houseConnected: false,
        waifuBotCount: 0,
        retrying: true,
        retryAttempt: discordRetryAttempt,
        nextRetryAt,
        lastError: message,
        lastErrorAt,
        warnings: [
          `${failureLabel}: ${message}`,
          `Discord auto-connect will retry automatically at ${nextRetryAt}.`
        ]
      };
      runtime.updatedAt = new Date().toISOString();
      await writeRuntimeFiles(options.dataRoot, runtime);
      logger.warn("Discord auto-connect retry scheduled", {
        attempt: discordRetryAttempt,
        nextRetryAt,
        delayMs,
        message,
        reason: retryOptions.logReason
      });
      discordRetryTimer = setTimeout(() => {
        discordRetryTimer = undefined;
        void enqueueReloadRuntime("discord-auto-retry", { scheduledRetry: true }).catch((error) => {
          const retryMessage = error instanceof Error ? error.message : String(error);
          logger.error("Discord auto-connect retry failed outside gateway connection", { message: retryMessage });
        });
      }, delayMs);
    };

    const handleDiscordRuntimeIssue = async (issue: DiscordRuntimeIssue) => {
      if (closing) return;
      if (updateActivity.snapshot().prepared || updateActivity.snapshot().stopping) return;
      const message = issue.message || "Discord runtime issue.";
      if (!isRetryableDiscordRuntimeIssue(issue)) {
        logger.warn("Discord runtime issue did not trigger reconnect", discordRuntimeIssueLogContext(issue));
        return;
      }

      pendingLiveDiscordErrorMessage = message;
      if (discordRetryTimer) {
        await scheduleDiscordRetry(message, {
          preserveExistingTimer: true,
          failureLabel: "Discord connection lost",
          logReason: issue.source
        });
        return;
      }
      if (discordRecoveryInProgress) {
        return;
      }

      discordRecoveryInProgress = true;
      try {
        logger.warn("Discord runtime issue triggered reconnect", discordRuntimeIssueLogContext(issue));
        await castRuntime?.stop();
        await gateway?.disconnect();
        castRuntime = undefined;
        gateway = undefined;
        runtime.queues.active = 0;
        await scheduleDiscordRetry(pendingLiveDiscordErrorMessage ?? message, {
          preserveExistingTimer: true,
          failureLabel: "Discord connection lost",
          logReason: issue.source
        });
      } finally {
        discordRecoveryInProgress = false;
        pendingLiveDiscordErrorMessage = undefined;
      }
    };

    // Live per-bot changes after connect (a waifu re-logged in, a token was revoked mid-session).
    const handleDiscordStatusChange = async (status: DiscordRuntimeStatus) => {
      if (closing) return;
      runtime.discord = status;
      runtime.updatedAt = new Date().toISOString();
      await writeRuntimeFiles(options.dataRoot, runtime);
    };

    const reloadRuntime = async (reason: string, retryOptions: { scheduledRetry?: boolean } = {}) => {
      if (closing) return;
      if (!retryOptions.scheduledRetry) {
        clearDiscordRetry();
        discordRetryAttempt = 0;
      }
      logger.info("Reloading runtime", { reason });
      await castRuntime?.stop();
      await gateway?.disconnect();
      castRuntime = undefined;
      gateway = undefined;
      runtime.queues.active = 0;

      const currentConfig = await loadAppConfig(options.dataRoot);
      await cleanupOcr(currentConfig);
      if (closing) return;
      runtime.paused = currentConfig.runtime.paused;
      runtime.queues.configuredGuilds = await countConfiguredGuilds(storage);
      if (currentConfig.runtime.autoConnectDiscord) {
        runtime.discord = connectingDiscordStatus();
        runtime.updatedAt = new Date().toISOString();
        await writeRuntimeFiles(options.dataRoot, runtime);
      }
      const connected = await maybeConnectDiscord(
        storage,
        currentConfig.runtime.autoConnectDiscord,
        logger,
        createDiscordGateway,
        handleDiscordRuntimeIssue,
        handleDiscordStatusChange,
        { directory, guildMembersIntent: currentConfig.discord.guildMembersIntent }
      );
      if (closing) {
        await connected.gateway?.disconnect();
        return;
      }
      runtime.discord = connected.status;
      gateway = connected.gateway;
      if (gateway) {
        clearDiscordRetry();
        discordRetryAttempt = 0;
        castRuntime = makeCastRuntime(gateway, currentConfig);
        await castRuntime.start();
      } else if (connected.retryableFailure) {
        await scheduleDiscordRetry(connected.retryableFailure.message);
      }
      if (closing) {
        await castRuntime?.stop();
        await gateway?.disconnect();
        castRuntime = undefined;
        gateway = undefined;
        return;
      }
      runtime.queues.configuredGuilds = await countConfiguredGuilds(storage);
      runtime.updatedAt = new Date().toISOString();
      await writeRuntimeFiles(options.dataRoot, runtime);
    };

    let reloadQueue: Promise<void> = Promise.resolve();
    enqueueReloadRuntime = (reason: string, retryOptions: { scheduledRetry?: boolean } = {}) => {
      const release = updateActivity.begin();
      if (!release) return Promise.reject(new Error("Update in progress; runtime reload deferred."));
      updateReloads++;
      const run = () => reloadRuntime(reason, retryOptions).finally(() => { updateReloads--; release(); });
      const next = reloadQueue.then(run, run);
      reloadQueue = next.catch(() => undefined);
      return next;
    };

    runtime.queues.configuredGuilds = await countConfiguredGuilds(storage);
    const app = await createApiServer({
      dataRoot: options.dataRoot,
      storage,
      runtime,
      updateActivity,
      runtimeControl: {
        getCastRuntime: () => castRuntime,
        pause: async () => {
          runtime.paused = true;
          await castRuntime?.pause();
          runtime.updatedAt = new Date().toISOString();
          await writeRuntimeFiles(options.dataRoot, runtime);
        },
        resume: async () => {
          runtime.paused = false;
          // Re-arm wakes the pause cleared / catch up a paused boot (no-op unless it was paused).
          castRuntime?.resumeAfterPause();
          runtime.updatedAt = new Date().toISOString();
          await writeRuntimeFiles(options.dataRoot, runtime);
        },
        reload: enqueueReloadRuntime
      },
      logger,
      directory,
      browserSecurity: {
        listenerHost: host,
        port,
        mode: options.mode ?? "start"
      },
      remoteTrust: {
        isAuthorized: (principal) => remoteAccess.isAuthorized(principal)
      },
      remoteAccess,
      ...(dashboardResolution.build ? { dashboardBuild: dashboardResolution.build } : {})
    });
    const remoteRequestBridge = new RemoteRequestBridge(app);
    remoteAccess.attachRequestBridge(remoteRequestBridge);
    let remoteRuntimeWriteQueue: Promise<void> = Promise.resolve();
    const unsubscribeRemoteAccess = remoteAccess.subscribe(() => {
      remoteRuntimeWriteQueue = remoteRuntimeWriteQueue
        .then(() => writeRuntimeFiles(options.dataRoot, runtime))
        .catch((error) => {
          logger.warn("Remote runtime status persistence failed", {
            message: error instanceof Error ? error.message : String(error)
          });
        });
    });

    await app.listen({ host, port });
    await remoteAccess.start();
    await writeRuntimeFiles(options.dataRoot, runtime);
    logger.info("Backend started", { url: `http://${host}:${port}`, dataRoot: options.dataRoot });
    void enqueueReloadRuntime("startup").catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Startup runtime reload failed", { message });
    });
    updateBusy = () => runtime.queues.active > 0 || discordRecoveryInProgress || remoteAccess.hasUpdateBlockers();
    updateNeedsCredentials = () => runtime.remoteAccess?.enabled === true;
    updateReady = true;

    return {
      url: `http://${host}:${port}`,
      runtime,
      remoteAccess,
      close: async () => {
        updateClosing = true;
        await updater?.close();
        closing = true;
        clearDiscordRetry();
        await reloadQueue;
        const shutdownStartedAt = Date.now();
        logger.info("Shutdown step start", { step: "remoteAccess.close" });
        let stepStartedAt = Date.now();
        await remoteAccess.close();
        unsubscribeRemoteAccess();
        await remoteRuntimeWriteQueue;
        logger.info("Shutdown step done", { step: "remoteAccess.close", ms: Date.now() - stepStartedAt });

        logger.info("Shutdown step start", { step: "runtime.stop" });
        stepStartedAt = Date.now();
        await castRuntime?.stop();
        logger.info("Shutdown step done", { step: "runtime.stop", ms: Date.now() - stepStartedAt });

        await directory.close();

        logger.info("Shutdown step start", { step: "discord.disconnect" });
        stepStartedAt = Date.now();
        await gateway?.disconnect();
        logger.info("Shutdown step done", { step: "discord.disconnect", ms: Date.now() - stepStartedAt });

        logger.info("Shutdown step start", { step: "fastify.close" });
        stepStartedAt = Date.now();
        await app.close();
        logger.info("Shutdown step done", { step: "fastify.close", ms: Date.now() - stepStartedAt });

        // Usage lines from calls outside the cast runtime (assistant) and any still
        // queued must reach disk before the host lock is released and the process may exit.
        await sharedUsageLedger(options.dataRoot).flush();

        await rm(appDataPath(options.dataRoot, "pid.json"), { force: true });
        runtime.updatedAt = new Date().toISOString();
        await atomicWriteJson(appDataPath(options.dataRoot, "runtime.json"), runtime);
        logger.info("Backend stopped", { dataRoot: options.dataRoot, totalMs: Date.now() - shutdownStartedAt });
      }
    };
  } catch (error) {
    await updater?.close();
    throw error;
  }
}

async function resolveRemoteDashboard(
  configuredStaticDir: string | undefined,
  logger: Logger
): Promise<{
  readonly dashboard: ResolvedRemoteDashboard;
  readonly build?: DashboardBuild;
}> {
  const resolved = await resolveStaticDir(configuredStaticDir);
  if (!resolved) {
    return {
      dashboard: {
        path: "",
        source: "custom",
        buildId: "dashboard-unavailable"
      }
    };
  }
  if (resolved.source === "custom") {
    return {
      dashboard: {
        ...resolved,
        buildId: "custom-dashboard"
      }
    };
  }
  try {
    const build = await DashboardBuild.load({ bundleDirectory: resolved.path });
    return {
      dashboard: {
        ...resolved,
        buildId: build.buildId
      },
      build
    };
  } catch (error) {
    logger.warn("Bundled dashboard manifest verification failed", {
      code: error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "dashboard_unavailable"
    });
    return {
      dashboard: {
        path: resolved.path,
        source: "custom",
        buildId: "dashboard-unavailable"
      }
    };
  }
}

function offlineDiscordStatus(warnings: string[] = []): DiscordRuntimeStatus {
  return {
    connected: false,
    houseConnected: false,
    waifuBotCount: 0,
    warnings
  };
}

function connectingDiscordStatus(): DiscordRuntimeStatus {
  return {
    connected: false,
    houseConnected: false,
    waifuBotCount: 0,
    warnings: [],
    connecting: true
  };
}

function withoutDiscordConnecting(status: DiscordRuntimeStatus): DiscordRuntimeStatus {
  const next = { ...status };
  delete next.connecting;
  return next;
}

async function maybeConnectDiscord(
  storage: StorageService,
  autoConnect: boolean,
  logger: Logger,
  createDiscordGateway: (options: DiscordJsGatewayOptions) => DiscordGatewayFacade,
  onRuntimeIssue: ((issue: DiscordRuntimeIssue) => void | Promise<void>) | undefined,
  onStatusChange: ((status: DiscordRuntimeStatus) => void | Promise<void>) | undefined,
  extra: { directory: GuildDirectory; guildMembersIntent: boolean }
): Promise<{
  status: DiscordRuntimeStatus;
  gateway?: DiscordGatewayFacade;
  retryableFailure?: { message: string };
}> {
  const offline = offlineDiscordStatus(
    autoConnect ? ["Discord auto-connect is enabled but no House bot token is configured."] : []
  );
  if (!autoConnect) {
    return { status: offline };
  }
  const bots = await storage.readJson(
    "user/discord-bots.json",
    DiscordBotsFileSchema,
    DiscordBotsFileSchema.parse(createEmptyRevisionedFile({ orchestrator: null, waifus: [] }))
  );
  if (!bots.orchestrator?.token) {
    return { status: offline };
  }
  if (bots.orchestrator.enabled === false) {
    // Waifu bots need the House bot (it reads the rooms and owns the commands), so nothing logs in without it.
    return { status: offlineDiscordStatus(["Discord auto-connect is enabled but the House bot is disabled."]) };
  }
  const cacheForGuild = async (guildId: string) => {
      const [members, emojis, roles] = await Promise.all([
        storage.readJson(
          `user/servers/${guildId}/members.json`,
          GuildMembersFileSchema,
          GuildMembersFileSchema.parse(createEmptyRevisionedFile({ guildId, members: [] }))
        ),
        storage.readJson(
          `user/servers/${guildId}/emojis.json`,
          GuildEmojisFileSchema,
          GuildEmojisFileSchema.parse(createEmptyRevisionedFile({ guildId, emojis: [] }))
        ),
        storage.readJson(
          `user/servers/${guildId}/roles.json`,
          GuildRolesFileSchema,
          GuildRolesFileSchema.parse(createEmptyRevisionedFile({ guildId, roles: [] }))
        )
      ]);
      return {
        members: mergeConfiguredBotsIntoMembers(members.members, bots),
        emojis: emojis.emojis,
        roles: roles.roles
      };
  };
  const gateway = createDiscordGateway({
    house: bots.orchestrator,
    waifus: bots.waifus,
    logger,
    guildMembersIntent: extra.guildMembersIntent,
    cacheForGuild,
    // The legacy fetchFreshContext paths (reviewer, /print, resume detection) still ask for a
    // refresh on unresolved mentions; it is the directory's single refresh path now (spec 9.4).
    refreshMembersForGuild: async (guildId) => {
      await extra.directory.refresh(guildId, "members");
      return { members: (await cacheForGuild(guildId)).members };
    },
    refreshRolesForGuild: async (guildId) => {
      await extra.directory.refresh(guildId, "roles");
      return { roles: (await cacheForGuild(guildId)).roles };
    },
    onRuntimeIssue,
    onStatusChange,
    // Spec 9.1: bots of DM-eligible waifus log in with the DM intents (re-read on reconcile).
    dmBots: async () => {
      const [waifus, current] = await Promise.all([listWaifus(storage), readDiscordBotsFile(storage)]);
      return computeDmEligibility(waifus, current).eligible;
    }
  });
  try {
    const status = await gateway.connect();
    return { status, gateway };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = isRetryableDiscordAutoConnectError(error);
    logger.error("Discord auto-connect failed", { message });
    await gateway.disconnect();
    return {
      status: {
        connected: false,
        houseConnected: false,
        waifuBotCount: 0,
        warnings: [`Discord auto-connect failed: ${message}`],
        lastError: message,
        lastErrorAt: new Date().toISOString(),
        ...(error instanceof DiscordConnectError && error.status.bots ? { bots: error.status.bots } : {})
      },
      retryableFailure: retryable ? { message } : undefined
    };
  }
}

const RETRYABLE_DISCORD_ERROR_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET"
]);

const RETRYABLE_DISCORD_MESSAGE_PATTERNS = [
  /\bgetaddrinfo\b/i,
  /\bdns\b/i,
  /\bnetwork\b/i,
  /\btimeout\b/i,
  /\btimed out\b/i,
  /\bsocket\b/i,
  /\bfetch failed\b/i,
  /\bconnection reset\b/i,
  /\bconnection refused\b/i,
  /\bunreachable\b/i
];

function isRetryableDiscordAutoConnectError(error: unknown): boolean {
  const code = errorCode(error);
  if (code && RETRYABLE_DISCORD_ERROR_CODES.has(code)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return RETRYABLE_DISCORD_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

function isRetryableDiscordRuntimeIssue(issue: DiscordRuntimeIssue): boolean {
  // discord.js resumes/re-identifies by itself after shard errors and recoverable closes, and only
  // emits ShardDisconnect for close codes it gives up on (bad token, disallowed intents, ...): a
  // reconnect cannot fix those, so the gateway marks that bot errored instead (see client.ts).
  if (issue.source === "shard-error" || issue.source === "shard-disconnect" || issue.source === "warn") {
    return false;
  }
  if (issue.source === "invalidated") {
    return true;
  }
  return isRetryableDiscordAutoConnectError(issue.error ?? issue) || isRetryableDiscordAutoConnectError(issue);
}

function discordRuntimeIssueLogContext(issue: DiscordRuntimeIssue): Record<string, unknown> {
  return {
    source: issue.source,
    botId: issue.botId,
    shardId: issue.shardId,
    code: issue.code,
    wasClean: issue.wasClean,
    message: issue.message
  };
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") return code;
  const nestedError = errorCode((error as { error?: unknown }).error);
  if (nestedError) return nestedError;
  return errorCode((error as { cause?: unknown }).cause);
}

async function countConfiguredGuilds(storage: StorageService): Promise<number> {
  try {
    const entries = await readdir(path.join(storage.dataRoot, "user", "servers"));
    return entries.length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

async function writeRuntimeFiles(dataRoot: string, runtime: RuntimeState): Promise<void> {
  await Promise.all([
    atomicWriteJson(appDataPath(dataRoot, "pid.json"), runtime),
    atomicWriteJson(appDataPath(dataRoot, "runtime.json"), runtime)
  ]);
}
