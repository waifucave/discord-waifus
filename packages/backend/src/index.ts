import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server as SocketIOServer } from "socket.io";
import { AIRouter } from "./ai-router.js";
import { setupChannelRoutes } from "./api/channels.js";
import { setupDebugRoutes, type DebugEventRecord } from "./api/debug.js";
import { handleRouteError } from "./api/helpers.js";
import { setupLiveRoutes } from "./api/live.js";
import { setupOrchestratorRoutes } from "./api/orchestrator.js";
import { setupProviderRoutes } from "./api/providers.js";
import { setupStageManagerRoutes } from "./api/stage-manager.js";
import { BotManager } from "./bot-manager.js";
import { ConfigManager } from "./config-manager.js";
import { IdleLoop } from "./idle-loop.js";
import { MessageHandler } from "./message-handler.js";
import { ListenerCommandManager } from "./listener-commands.js";
import { Orchestrator } from "./orchestrator.js";
import { RuntimeEventBus } from "./runtime-events.js";
import { StageManager } from "./stage-manager.js";
import { StageManagerDataStore } from "./stage-manager-store.js";
import { setupStatusRoutes } from "./api/status.js";
import { setupWaifuRoutes } from "./api/waifus.js";
import { Logger } from "./utils/logger.js";

const logger = new Logger("Backend");
const allowedOrigins = ["http://localhost:3000", "http://127.0.0.1:3000"];
type RuntimeSyncMode = "full" | "channels" | "none";

async function main(): Promise<void> {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const workspaceRoot = path.resolve(currentDir, "../../../");

  const configManager = new ConfigManager(workspaceRoot);
  await configManager.load();

  const app = express();
  const server = createServer(app);
  const io = new SocketIOServer(server, {
    cors: {
      origin: allowedOrigins
    }
  });

  app.use(cors({ origin: allowedOrigins }));
  app.use(express.json());
  app.use("/local-assets", express.static(configManager.paths.assetsRoot));
  const events = new RuntimeEventBus();
  const recentDebugEvents: DebugEventRecord[] = [];

  const pushDebugEvent = (type: string, payload: Record<string, unknown>) => {
    recentDebugEvents.push({
      timestamp: new Date().toISOString(),
      type,
      payload
    });
    if (recentDebugEvents.length > 50) {
      recentDebugEvents.shift();
    }
  };

  const botManager = new BotManager({
    workspaceRoot,
    localAssetsRoot: configManager.paths.assetsRoot
  });
  const messageHandler = new MessageHandler(botManager);
  const aiRouter = new AIRouter(configManager.providers);
  const stageManagerStore = new StageManagerDataStore(configManager.paths);
  await stageManagerStore.load();
  const orchestrator = new Orchestrator(
    aiRouter,
    configManager,
    botManager,
    messageHandler,
    stageManagerStore,
    events
  );
  const stageManager = new StageManager(
    aiRouter,
    configManager,
    botManager,
    messageHandler,
    stageManagerStore,
    events
  );
  const listenerCommands = new ListenerCommandManager(
    configManager,
    async (channelId) => {
      await orchestrator.handleIdleTrigger(channelId);
    },
    pushDebugEvent
  );
  const idleLoop = new IdleLoop(orchestrator);
  let runtimeSync: Promise<void> = Promise.resolve();

  const queueRuntimeSync = (mode: RuntimeSyncMode = "full") => {
    runtimeSync = runtimeSync
      .then(() => syncRuntime(configManager, botManager, idleLoop, listenerCommands, mode))
      .catch((error) => {
        logger.error("Runtime sync failed", error);
      });
    return runtimeSync;
  };

  botManager.setOnMessageHandler(async ({ message }) => {
    const formatted = await messageHandler.formatMessage(message);
    logger.info("Discord message received", {
      id: formatted.id,
      channelId: message.channelId,
      author: formatted.authorDisplayName,
      content: formatted.content
    });

    events.emit("chat:message", {
      channelId: message.channelId,
      id: formatted.id,
      content: formatted.content,
      authorName: formatted.authorDisplayName,
      authorAvatar: message.author.displayAvatarURL(),
      isWaifu: formatted.isWaifu,
      waifuId: formatted.waifuId,
      timestamp: formatted.timestamp
    });
    pushDebugEvent("discord.message", {
      messageId: formatted.id,
      channelId: message.channelId,
      author: formatted.authorDisplayName,
      isWaifu: formatted.isWaifu,
      content: formatted.content
    });

    await orchestrator.handleNewMessage(message.channelId, message);
  });
  botManager.setOnInteractionHandler(async ({ interaction }) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    await listenerCommands.handleInteraction(interaction);
  });
  botManager.setOnListenerReadyHandler(async ({ client, waifuId }) => {
    await listenerCommands.register(client);
    pushDebugEvent("listener.commands.synced", {
      waifuId,
      guildIds: [...new Set(configManager.channels.map((channel) => channel.guildId))]
    });
  });

  setupStatusRoutes(app, {
    botManager,
    config: configManager,
    orchestrator,
    stageManager
  });
  setupWaifuRoutes(app, {
    config: configManager,
    botManager,
    stageManagerStore
  });
  setupProviderRoutes(app, {
    config: configManager,
    aiRouter
  });
  setupOrchestratorRoutes(app, {
    config: configManager
  });
  setupStageManagerRoutes(app, {
    config: configManager,
    stageManager
  });
  setupChannelRoutes(app, {
    config: configManager,
    botManager
  });
  setupDebugRoutes(app, {
    botManager,
    config: configManager,
    getRecentEvents: () => [...recentDebugEvents]
  });
  setupLiveRoutes(app);

  await queueRuntimeSync();
  await stageManager.reconcileOnStartup();

  io.on("connection", (socket) => {
    socket.on("subscribe", ({ channelId }: { channelId: string }) => {
      socket.join(`channel:${channelId}`);
    });

    socket.on("unsubscribe", ({ channelId }: { channelId: string }) => {
      socket.leave(`channel:${channelId}`);
    });
  });

  events.on("chat:message", (payload) => {
    io.to(`channel:${payload.channelId}`).emit("chat:message", payload);
    pushDebugEvent("chat.message", {
      channelId: payload.channelId,
      authorName: payload.authorName,
      isWaifu: payload.isWaifu,
      waifuId: payload.waifuId,
      content: payload.content
    });
    const channelConfig = configManager.channels.find(
      (entry) => entry.channelId === payload.channelId && entry.idleChatterEnabled
    );
    if (channelConfig) {
      idleLoop.resetForChannel(payload.channelId, channelConfig);
    }
  });
  events.on("orchestrator:decision", (payload) =>
    {
      io.to(`channel:${payload.channelId}`).emit("orchestrator:decision", payload);
      pushDebugEvent("orchestrator.decision", {
        channelId: payload.channelId,
        action: payload.action,
        reasoning: payload.reasoning,
        waifus: payload.respondingWaifus.map((entry) => ({
          waifuId: entry.waifuId,
          delaySeconds: entry.delaySeconds,
          replyStyle: entry.replyStyle,
          sceneDirection: entry.sceneDirection
        })),
        directInteraction: payload.directInteraction,
        retriggerAfterSeconds: payload.retriggerAfterSeconds
      });
      if (payload.action === "no_reply" && payload.retriggerAfterSeconds) {
        const channelConfig = configManager.channels.find(
          (entry) => entry.channelId === payload.channelId && entry.idleChatterEnabled
        );
        if (channelConfig) {
          idleLoop.snoozeForChannel(
            payload.channelId,
            channelConfig,
            payload.retriggerAfterSeconds
          );
        }
      }
    }
  );
  events.on("generation:start", (payload) =>
    {
      io.to(`channel:${payload.channelId}`).emit("generation:start", payload);
      pushDebugEvent("generation.start", {
        channelId: payload.channelId,
        waifuId: payload.waifuId,
        waifuName: payload.waifuName,
        responseIndex: payload.responseIndex,
        replyStyle: payload.replyStyle,
        delaySeconds: payload.delaySeconds,
        replyToMessageId: payload.replyToMessageId,
        sceneDirection: payload.sceneDirection
      });
    }
  );
  events.on("generation:token", (payload) =>
    io.to(`channel:${payload.channelId}`).emit("generation:token", payload)
  );
  events.on("generation:complete", (payload) =>
    {
      io.to(`channel:${payload.channelId}`).emit("generation:complete", payload);
      pushDebugEvent("generation.complete", {
        channelId: payload.channelId,
        waifuId: payload.waifuId,
        responseIndex: payload.responseIndex,
        messageId: payload.messageId,
        tokenCount: payload.tokenCount,
        durationMs: payload.durationMs,
        finishReason: payload.finishReason,
        usage: payload.usage,
        rawContent: payload.rawContent,
        content: payload.content
      });
    }
  );
  events.on("generation:cancelled", (payload) =>
    {
      io.to(`channel:${payload.channelId}`).emit("generation:cancelled", payload);
      pushDebugEvent("generation.cancelled", {
        channelId: payload.channelId,
        waifuId: payload.waifuId ?? null,
        reason: payload.reason
      });
    }
  );
  events.on("stage-manager:scheduled", (payload) => {
    io.to(`channel:${payload.channelId}`).emit("stage-manager:scheduled", payload);
    pushDebugEvent("stage-manager.scheduled", { ...payload });
  });
  events.on("stage-manager:start", (payload) => {
    io.to(`channel:${payload.channelId}`).emit("stage-manager:start", payload);
    pushDebugEvent("stage-manager.start", { ...payload });
  });
  events.on("stage-manager:complete", (payload) => {
    io.to(`channel:${payload.channelId}`).emit("stage-manager:complete", payload);
    pushDebugEvent("stage-manager.complete", { ...payload });
  });
  events.on("stage-manager:error", (payload) => {
    io.to(`channel:${payload.channelId}`).emit("stage-manager:error", payload);
    pushDebugEvent("stage-manager.error", { ...payload });
  });

  configManager.on("reloaded", ({ changedPath }) => {
    aiRouter.setProviders(configManager.providers);
    stageManager.handleConfigChanged();
    events.emit("config:reloaded", {
      changedPath,
      timestamp: new Date().toISOString()
    });
    pushDebugEvent("config.reloaded", {
      changedPath
    });
    const syncMode = getRuntimeSyncMode(changedPath);
    if (syncMode !== "none") {
      void queueRuntimeSync(syncMode);
    }
  });
  app.use(handleRouteError);

  server.listen(4000, "127.0.0.1", () => {
    logger.info("Backend listening", { url: "http://127.0.0.1:4000" });
  });
}

main().catch((error) => {
  logger.error("Backend failed to start", error);
  process.exitCode = 1;
});

async function syncRuntime(
  configManager: ConfigManager,
  botManager: BotManager,
  idleLoop: IdleLoop,
  listenerCommands: ListenerCommandManager,
  mode: RuntimeSyncMode
): Promise<void> {
  if (mode === "full") {
    await syncBots(configManager, botManager);
    syncIdleLoop(configManager, idleLoop);
    return;
  }

  if (mode === "channels") {
    await syncChannelRuntime(configManager, botManager, listenerCommands);
    syncIdleLoop(configManager, idleLoop);
  }
}

async function syncBots(
  configManager: ConfigManager,
  botManager: BotManager
): Promise<void> {
  for (const status of botManager.getBotStatuses()) {
    await botManager.stopBot(status.waifuId);
  }

  for (const waifu of configManager.waifus.filter((entry) => entry.enabled)) {
    await botManager.startBot(waifu);
    await botManager.applyGuildNicknames(waifu.id, getGuildIdsForWaifu(configManager, waifu.id));
  }
}

async function syncChannelRuntime(
  configManager: ConfigManager,
  botManager: BotManager,
  listenerCommands: ListenerCommandManager
): Promise<void> {
  for (const waifu of configManager.waifus.filter((entry) => entry.enabled)) {
    await botManager.applyGuildNicknames(waifu.id, getGuildIdsForWaifu(configManager, waifu.id));
  }

  const listenerClient = botManager.getListenerClient();
  if (listenerClient) {
    await listenerCommands.register(listenerClient);
  }
}

function syncIdleLoop(configManager: ConfigManager, idleLoop: IdleLoop): void {
  idleLoop.stopAll();
  for (const channel of configManager.channels.filter(
    (entry) => entry.enabled && entry.idleChatterEnabled
  )) {
    idleLoop.startForChannel(channel.channelId, channel);
  }
}

function getGuildIdsForWaifu(configManager: ConfigManager, waifuId: string): string[] {
  // Discord nicknames are guild-specific and do not affect the bot's global username in DMs.
  return [
    ...new Set(
      configManager.channels
        .filter((channel) => channel.activeWaifuIds.includes(waifuId))
        .map((channel) => channel.guildId)
    )
  ];
}

function getRuntimeSyncMode(changedPath: string): RuntimeSyncMode {
  switch (path.basename(changedPath)) {
    case "waifus.json":
      return "full";
    case "channels.json":
      return "channels";
    case "stage-manager.json":
      return "none";
    default:
      return "none";
  }
}
