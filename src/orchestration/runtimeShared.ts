// Types and small helpers shared by RuntimeOrchestrator (runtime.ts) and its collaborators.

import { Logger } from "../backend/logger.js";
import { DiscordGatewayFacade } from "../discord/client.js";
import { ModelPipeline } from "../providers/types.js";
import { QueryRole } from "../shared/queryLog.js";
import { OrchestratorRespondingWaifu } from "../shared/schemas/domain.js";
import { StorageService } from "../storage/storageService.js";
import type { RetriggerSource } from "./session.js";
import type { ContextMessage } from "./contextMessages.js";
import type { OneShotInput, OneShotResult } from "./oneShot/decider.js";
import type { ImageCacheConfig, ImageFetcher } from "../discord/attachments.js";
import type { ImageRef } from "../shared/schemas/discordMessage.js";
import type { CompactionSettings } from "../shared/schemas/compaction.js";
import type { MemoryConfig } from "../shared/schemas/config.js";
import type { ContextRuntime } from "./context/runtime.js";
import type { CompactionService } from "./context/types.js";

export type RuntimeOrchestratorOptions = {
  updateActivity?: import("../backend/updates/activity.js").UpdateActivity;
  storage: StorageService;
  discord: DiscordGatewayFacade;
  logger: Logger;
  maxAutomaticTurns?: number;
  /** Defaults to the shared per-data-root instances. */
  usageLedger?: import("./usageLedger.js").UsageLedger;
  providerAlerts?: import("./providerAlerts.js").ProviderAlerts;
  isPaused?: () => boolean;
  onActiveRunsChange?: (activeRuns: number) => void;
  createPipeline?: (target: { providerId: string; modelId: string; queryRole: QueryRole }) => ModelPipeline;
  decideOneShot?: (input: OneShotInput) => Promise<OneShotResult>;
  ocr?: {
    enrichMessages(messages: ContextMessage[], options?: { signal?: AbortSignal }): Promise<ContextMessage[]>;
    /** Cached OCR text without running OCR (ImageOcrService.cachedText); feeds the image freeze rule. */
    cachedText?(ref: ImageRef): Promise<string | undefined>;
    dispose?(): Promise<void>;
  };
  /** Shared Discord image fetcher (the OCR service's, spec 8.4); built over the data root when omitted. */
  images?: ImageFetcher;
  /** `AppConfig.discord.images`, used only when `images` is omitted. */
  imageConfig?: Partial<ImageCacheConfig>;
  /** `AppConfig.compaction`; `ServerConfig.compaction` overrides per key. */
  compaction?: CompactionSettings;
  /** Context compaction service (T7b); NoopCompaction when omitted. */
  contextCompaction?: CompactionService;
  /** Prebuilt context runtime (tests); otherwise createAppContextRuntime builds one. */
  contexts?: ContextRuntime;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  stageManagerIdleDelayMs?: number;
  /** Delay before boot catch-up runs (lets Discord bots finish connecting). Default 5000. */
  restartResumeDelayMs?: number;
  /** AppConfig `memory` section (dream hour, pinned cap) plus a test hook for the nightly budget. */
  memory?: Partial<MemoryConfig> & { dreamChunksPerNight?: number };
};

/**
 * Collaborator deps: the orchestrator options plus the one ContextRuntime the facade builds
 * (spec 8.3). Every collaborator (ResponderExecutor, ChannelRunner, ...) reads `options.contexts`.
 */
export type RuntimeCollaboratorOptions = RuntimeOrchestratorOptions & { contexts: ContextRuntime };

/** The narrow I/O services most runtime collaborators need. */
export type RuntimeServices = Pick<RuntimeOrchestratorOptions, "storage" | "discord" | "logger" | "isPaused" | "memory">;

/** RuntimeServices plus the shared context engine (reply path, orchestrator). */
export type RuntimeContextServices = RuntimeServices & Pick<RuntimeCollaboratorOptions, "contexts">;

/** Facade-owned lifecycle hooks shared with the collaborators. */
export type RuntimeHooks = {
  runBackground(label: string, context: Record<string, unknown>, task: () => void | Promise<unknown>): void;
  isStopping(): boolean;
};

export type ChannelRunOptions = {
  initialResponders?: OrchestratorRespondingWaifu[];
  initialReason?: string;
  firstOrchestratorMustReply?: boolean;
  firstResponderSceneDirectionOverride?: string;
  // message/manual (and untagged callers: /run, API, reviewer) may preempt another channel's run;
  // retrigger (timer wakes) and resume (boot catch-up) never do — they queue instead.
  trigger?: "message" | "retrigger" | "manual" | "resume";
  /** For timer wakes: who armed the timer (absent for pre-source persisted timers). */
  wake?: RetriggerWakeInput;
};

export type RetriggerWakeInput = { source: RetriggerSource; seconds?: number; decisionId?: string };

export type StageManagerRunResult = {
  status: "updated" | "no_change" | "already_running" | "disabled" | "failed";
  message?: string;
};

export type DreamPassResult = {
  status: "updated" | "no_change" | "already_running" | "disabled" | "failed";
  applied: number;
  skipped: number;
  chunks: number;
  message?: string;
};

export function runKey(guildId: string): string {
  return guildId;
}

export function timerKey(guildId: string, channelId: string): string {
  return `${guildId}:${channelId}`;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted.");
  }
}

export function summarizeProviderPipelineDetails(details: unknown): string {
  try {
    return JSON.stringify(details).slice(0, 4000);
  } catch {
    return String(details).slice(0, 4000);
  }
}

export function incrementActive(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

export function decrementActive(map: Map<string, number>, key: string): void {
  const next = (map.get(key) ?? 0) - 1;
  if (next > 0) {
    map.set(key, next);
  } else {
    map.delete(key);
  }
}

export function isHumanUserMessage(message: ContextMessage): boolean {
  return message.authorKind === "user" && message.authorBot !== true;
}
