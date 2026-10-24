// Per-channel run loop: one run slot per guild with human/manual preemption and a deduped
// preemption queue, orchestrator decisions (model / deterministic / one-shot) with guardrails and
// overrides, decision recording, retrigger timers, crash-recovery wakes and restart resume.

import { randomUUID } from "node:crypto";
import type { ResolvedModel, Usage } from "@waifucave/gateway";
import { loadGuildDirectoryView } from "../discord/directoryView.js";
import { PermissionWarningTracker, isPermissionError } from "./permissionWarnings.js";
import {
  type DeterministicCastMember,
  decideDeterministically,
  enforceWakePlan,
  forceReplyDecision
} from "./deterministicOrchestrator.js";
import type { LedgerEntry } from "../shared/schemas/context.js";
import { resolveBotAuthorIds } from "../shared/botIdentity.js";
import { contextSummarizer } from "./context/compaction.js";
import { conversationKey, type ContextAgent } from "./context/keys.js";
import type { ModelCallAttribution, PreparedContext } from "./context/types.js";
import {
  type OrchestratorMode,
  assessOrchestratorTurn,
  buildCastCards,
  createOrchestratorRenderer,
  ledgerToContextMessages,
  orchestratorPlace,
  waifuAuthorMatcher
} from "./orchestratorHarness.js";
import { decisionNoteFor } from "./pipeline/timeline.js";
import { ORCHESTRATOR_TOOL_NAME } from "./tools.js";
import { planRestartResume } from "./restartResume.js";
import { GatewayPipelineError, TruncatedOutputError } from "./pipeline/params.js";
import {
  OrchestratorDecisionHistoryEntry,
  OrchestratorDecisionStatus,
  OrchestratorHistoryFileSchema,
  OrchestratorResponderOutcome,
  ServerConfig,
  createEmptyRevisionedFile
} from "../shared/schemas/domain.js";
import { nowIso } from "../shared/schemas/common.js";
import { ChannelSessionStateSchema, type RetriggerWake, createEmptyChannelSessionState } from "./session.js";
import type { ContextMessage } from "./contextMessages.js";
import {
  DIRECTIVE_GOAL_MAX_CHARS,
  type DirectiveIntent,
  MAX_WAIFU_DELAY_SECONDS,
  type OrchestratorDecision,
  RETRIGGER_DEFAULT_SECONDS,
  RETRIGGER_MAX_SECONDS,
  RETRIGGER_MIN_SECONDS
} from "./decisions.js";
import { OneShotDecider } from "./oneShot/decider.js";
import { sendOrchestratorDebugLog } from "./debugLog.js";
import { ModelAccess } from "./modelAccess.js";
import { buildDeterministicCast } from "./promptBuilders.js";
import { ResponderExecutor } from "./responderExecutor.js";
import {
  type ChannelRunOptions,
  type RetriggerWakeInput,
  type RuntimeHooks,
  type RuntimeCollaboratorOptions,
  isHumanUserMessage,
  runKey,
  summarizeProviderPipelineDetails,
  throwIfAborted,
  timerKey
} from "./runtimeShared.js";
import {
  channelHasWaifus,
  ensureServer,
  listAvailableWaifusForChannel,
  listKnownGuildIds,
  listWaifus,
  readAgentConfig,
  readDiscordBotsFile
} from "./stores/config.js";
import {
  appendOrchestratorHistory,
  readCompletedOrchestratorDecisionsForChannel,
  readOrchestratorDecision,
  updateOrchestratorResponderOutcome
} from "./stores/decisionHistory.js";
import { noteActiveChatParticipantsFromContext } from "./stores/participants.js";
import { consumeScheduledRetrigger, markSessionIdle, sessionRelativePath, setActivePipeline, updateSession } from "./stores/sessions.js";
import { resolveContextCap } from "./contextWindows.js";

export type ActiveChannelRun = {
  guildId: string;
  channelId: string;
  controller: AbortController;
  promise: Promise<void>;
  trigger?: ChannelRunOptions["trigger"];
  wake?: RetriggerWakeInput;
};

type ChannelRunnerOptions = Pick<
  RuntimeCollaboratorOptions,
  | "storage"
  | "discord"
  | "logger"
  | "isPaused"
  | "ocr"
  | "decideOneShot"
  | "restartResumeDelayMs"
  | "onActiveRunsChange"
  | "contexts"
>;

export class ChannelRunner {
  readonly activeRuns = new Map<string, ActiveChannelRun>();
  readonly retriggerTimers = new Map<string, NodeJS.Timeout>();
  readonly channelRunVersions = new Map<string, number>();
  // Consecutive crashed runs per guildId:channelId, for the crash-recovery wake backoff.
  private readonly recoveryAttempts = new Map<string, number>();
  // Per guild: channels whose run was aborted by another channel's run (insertion-ordered,
  // deduped). Each gets a short retrigger when the guild's run slot frees up.
  // The value is the wake identity to re-arm with: the deferred/aborted timer wake's own identity,
  // or { source: "preempted" } for an aborted human-message/manual run.
  readonly preemptedChannels = new Map<string, Map<string, RetriggerWakeInput>>();
  // Per-channel directive budget counter. Increments each decision a directive is not honored,
  // resets to 0 when one is honored; the budget opens once it reaches directiveCooldown.
  private readonly directiveDecisionCounts = new Map<string, number>();

  constructor(
    private readonly options: ChannelRunnerOptions,
    private readonly hooks: RuntimeHooks,
    private readonly models: ModelAccess,
    private readonly executor: ResponderExecutor,
    private readonly oneShot: OneShotDecider,
    private readonly permissionWarnings: PermissionWarningTracker,
    private readonly maxAutomaticTurns: number
  ) {}

  /** True while a channel run holds (or belongs to) the guild's run slot. */
  isGuildRunActive(guildId: string): boolean {
    return this.activeRuns.has(runKey(guildId)) || [...this.activeRuns.values()].some((run) => run.guildId === guildId);
  }

  /**
   * Pretend the server was never restarted: re-arm persisted retriggers with their REMAINING
   * time, and re-execute decision responders whose lines the restart ate (directives intact,
   * via the initialResponders path so all normal run bookkeeping applies).
   */
  async resumeOrchestrationState(): Promise<void> {
    // give the Discord bots a beat to finish connecting; failed sends self-heal regardless
    await new Promise((resolve) => setTimeout(resolve, this.options.restartResumeDelayMs ?? 5000));
    if (this.hooks.isStopping() || this.options.isPaused?.()) return;
    const guildIds = await listKnownGuildIds(this.options.storage);
    const history = await this.options.storage.readJson(
      "user/orchestrator/history.json",
      OrchestratorHistoryFileSchema,
      OrchestratorHistoryFileSchema.parse(createEmptyRevisionedFile({ decisions: [] }))
    );
    for (const guildId of guildIds) {
      let server: ServerConfig;
      try {
        server = await ensureServer(this.options.storage, guildId);
      } catch {
        continue;
      }
      if (!server.enabled) continue;
      // Resumed replies in one guild run one after another (never preempting each other).
      const resumes: Array<() => Promise<void>> = [];
      for (const channel of Object.values(server.channels)) {
        if (!channelHasWaifus(channel)) continue;
        const channelId = channel.channelId;
        // After a live resume (not boot) the room may already be moving again: never replan a
        // channel whose run is live or whose latest decision is still in flight.
        if (this.activeRuns.get(runKey(guildId))?.channelId === channelId) continue;
        const session = await this.options.storage.readJson(
          sessionRelativePath(guildId, channelId),
          ChannelSessionStateSchema,
          createEmptyChannelSessionState(guildId, channelId)
        );
        // history is newest-first; find() returns the latest decision for this channel
        const latestDecision = history.decisions.find(
          (decision) => decision.guildId === guildId && decision.channelId === channelId
        );
        if (latestDecision?.status === "pending") continue;
        // Best-effort: a human message that landed while the server was down must wake the
        // channel promptly instead of resuming the old schedule (live 2026-07-06 10:08: K's
        // message hit the deploy window and waited out a restored 130s timer).
        let newestHumanMessageAt: string | undefined;
        try {
          const recent = await this.options.discord.fetchFreshContext({ guildId, channelId, limit: 10 });
          newestHumanMessageAt = recent.reduce<string | undefined>(
            (acc, message) =>
              message.authorKind === "user" && message.authorBot !== true && (!acc || message.timestamp > acc)
                ? message.timestamp
                : acc,
            undefined
          );
        } catch {
          // Discord not ready or channel unreadable — fall back to schedule-only planning.
        }
        const plan = planRestartResume({ guildId, channelId, session, latestDecision, newestHumanMessageAt }, new Date());
        if (plan.kind === "restore-timer") {
          if (this.retriggerTimers.has(timerKey(guildId, channelId))) continue;
          this.options.logger.info("Restart resume: retrigger restored", {
            guildId,
            channelId,
            seconds: plan.seconds,
            reason: plan.reason
          });
          await this.scheduleRetrigger(guildId, channelId, plan.seconds, plan.wake);
        } else if (plan.kind === "resume-responders") {
          this.options.logger.info("Restart resume: executing responders the restart interrupted", {
            guildId,
            channelId,
            decisionId: plan.decisionId,
            responders: plan.responders.map((responder) => responder.waifuId)
          });
          resumes.push(() =>
            this.startChannelRun(guildId, channelId, "restart-resume", {
              initialResponders: plan.responders,
              initialReason: `Resuming a decision interrupted by a server restart: ${plan.reasoning}`,
              trigger: "resume"
            })
          );
        }
      }
      if (resumes.length > 0) {
        this.hooks.runBackground("Restart resume run failed", { guildId }, async () => {
          for (const resume of resumes) await resume();
        });
      }
    }
  }

  startChannelRunBackground(
    guildId: string,
    channelId: string,
    reason: string,
    options: ChannelRunOptions = {}
  ): void {
    this.hooks.runBackground("Background channel run failed", { guildId, channelId, reason }, () =>
      this.startChannelRun(guildId, channelId, reason, options)
    );
  }

  markSessionIdleBackground(guildId: string, channelId: string, reason: string): void {
    this.hooks.runBackground("Failed to mark session idle", { guildId, channelId, reason }, () =>
      markSessionIdle(this.options.storage, guildId, channelId)
    );
  }

  async startChannelRun(
    guildId: string,
    channelId: string,
    reason: string,
    options: ChannelRunOptions = {}
  ): Promise<void> {
    // Every entry point (messages, timers, /run, restart resume, reviewer) funnels through here,
    // so the runtime-wide pause is enforced once for all of them.
    if (this.options.isPaused?.()) {
      this.options.logger.info("Channel run not started because runtime is paused", { guildId, channelId, reason });
      return;
    }
    // Runs are keyed per GUILD on purpose: a waifu is one Discord bot/persona shared by every
    // channel of the guild that enables her, so two concurrent channel runs could have the same
    // character generating and typing in two rooms at once (and double the guild's model spend).
    // /run, /stop, the reviewer and the dream deferral all rely on this one-run-per-guild slot.
    // Only human messages and manual commands preempt: they abort the other channel's run, which
    // is queued (deduped) and re-triggered shortly after the guild's slot frees, so its reply is
    // not lost. Timer wakes and boot catch-up never abort anything — they queue behind the live
    // run (keeping their wake identity), so two busy channels cannot ping-pong extra passes.
    const key = runKey(guildId);
    const existing = this.activeRuns.get(key);
    if (existing && (options.trigger === "retrigger" || options.trigger === "resume")) {
      if (existing.channelId !== channelId) {
        this.notePreemptedChannel(guildId, channelId, options.wake ?? { source: "preempted" });
        this.options.logger.info("Deferred channel wake behind another channel's active run", {
          guildId,
          channelId,
          activeChannelId: existing.channelId,
          reason
        });
      } else {
        // This channel's own live run already covers the room; it schedules its own next wake.
        this.options.logger.info("Dropped channel wake; the channel's run is already active", { guildId, channelId, reason });
      }
      return;
    }
    const versionKey = timerKey(guildId, channelId);
    this.channelRunVersions.set(versionKey, (this.channelRunVersions.get(versionKey) ?? 0) + 1);
    this.dropPreemptedChannel(guildId, channelId);
    if (existing) {
      this.options.logger.info("Restarting active channel run", {
        guildId,
        channelId,
        previousChannelId: existing.channelId,
        reason
      });
      existing.controller.abort(new Error(`restarted by ${reason}`));
      this.markSessionIdleBackground(existing.guildId, existing.channelId, `restarted by ${reason}`);
      if (existing.channelId !== channelId) {
        // An aborted timer-wake run keeps its own wake identity (marker, cast-wake budget); an
        // aborted human/manual run comes back as a "preempted" pass.
        const requeueWake = existing.trigger === "retrigger" && existing.wake ? existing.wake : { source: "preempted" as const };
        this.notePreemptedChannel(guildId, existing.channelId, requeueWake);
      }
    }
    this.clearRetriggerTimer(guildId, channelId);

    const controller = new AbortController();
    const recoveryKey = timerKey(guildId, channelId);
    const promise = this.runChannelLoop(guildId, channelId, controller.signal, options)
      .then(() => {
        this.recoveryAttempts.delete(recoveryKey);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (isPermissionError(error)) {
          this.permissionWarnings.record(guildId, channelId, "a waifu bot", error);
        }
        this.options.logger.error("Channel runtime loop failed", {
          guildId,
          channelId,
          message: error instanceof Error ? error.message : String(error),
          details: error instanceof GatewayPipelineError ? summarizeProviderPipelineDetails(error.details) : undefined
        });
        // A run that dies (provider outage, safety block, …) has already cleared any pending
        // retrigger timer — without a recovery wake the channel stays dead until the next human
        // message that doesn't crash (live incident 2026-07-05: a Gemini PROHIBITED_CONTENT block
        // silenced an active room for hours). Fresh context on the retry usually clears the block.
        // Consecutive crashes back off exponentially (3m, 6m, 12m … capped at 2h) so a permanent
        // failure does not burn a model call every 3 minutes forever; a clean run resets it.
        const attempt = (this.recoveryAttempts.get(recoveryKey) ?? 0) + 1;
        this.recoveryAttempts.set(recoveryKey, attempt);
        const recoverySeconds = recoveryRetriggerSeconds(attempt);
        this.options.logger.warn("Scheduling crash-recovery wake", {
          guildId,
          channelId,
          attempt,
          seconds: recoverySeconds
        });
        void this.scheduleRetrigger(guildId, channelId, recoverySeconds, { source: "crash_recovery" }).catch(() => undefined);
      })
      .finally(async () => {
        if (this.activeRuns.get(key)?.controller === controller) {
          this.activeRuns.delete(key);
          this.options.onActiveRunsChange?.(this.activeRuns.size);
          try {
            await markSessionIdle(this.options.storage, guildId, channelId);
          } catch (error) {
            this.options.logger.error("Failed to mark session idle", {
              guildId,
              channelId,
              reason,
              message: error instanceof Error ? error.message : String(error)
            });
          }
          await this.retriggerPreemptedChannel(guildId);
        }
      });
    this.activeRuns.set(key, { guildId, channelId, controller, promise, trigger: options.trigger, wake: options.wake });
    this.options.onActiveRunsChange?.(this.activeRuns.size);
    this.options.logger.info("Channel runtime loop started", { guildId, channelId, reason });
    await promise;
  }

  private notePreemptedChannel(guildId: string, channelId: string, wake: RetriggerWakeInput): void {
    const pending = this.preemptedChannels.get(guildId) ?? new Map<string, RetriggerWakeInput>();
    // An interrupted human/manual turn outranks a deferred timer wake for the same channel.
    if (pending.get(channelId)?.source !== "preempted") pending.set(channelId, wake);
    this.preemptedChannels.set(guildId, pending);
  }

  dropPreemptedChannel(guildId: string, channelId: string): void {
    const pending = this.preemptedChannels.get(guildId);
    if (!pending) return;
    pending.delete(channelId);
    if (pending.size === 0) this.preemptedChannels.delete(guildId);
  }

  // The guild's run slot just freed: give the oldest preempted channel its turn back.
  private async retriggerPreemptedChannel(guildId: string): Promise<void> {
    if (this.hooks.isStopping() || this.options.isPaused?.() || this.activeRuns.has(runKey(guildId))) return;
    const entry = this.preemptedChannels.get(guildId)?.entries().next().value;
    if (entry === undefined) return;
    const [next, wake] = entry;
    this.dropPreemptedChannel(guildId, next);
    // An already-armed wake will run the channel anyway; never shorten or replace it.
    if (this.retriggerTimers.has(timerKey(guildId, next))) return;
    this.options.logger.info("Re-triggering channel queued behind another channel's run", {
      guildId,
      channelId: next,
      source: wake.source
    });
    try {
      // scheduleRetrigger re-checks /stop, pause and newer runs after its write.
      await this.scheduleRetrigger(guildId, next, PREEMPTED_RETRIGGER_SECONDS, wake);
    } catch (error) {
      this.options.logger.warn("Failed to re-trigger preempted channel", {
        guildId,
        channelId: next,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async runChannelLoop(
    guildId: string,
    channelId: string,
    signal: AbortSignal,
    options: ChannelRunOptions = {}
  ): Promise<void> {
    let turns = 0;
    // Tracks the newest human message seen across loop iterations so the post-limit
    // cooldown can distinguish an active room from cast-only self-chatter.
    let lastHumanMessageTs: string | undefined;
    // Whatever wake was persisted is consumed by this run (it either fired, or this run
    // supersedes it); every exit path that wants a later pass schedules a fresh one. Leaving it
    // set made every boot fire a spurious "retrigger elapsed during downtime" wake.
    await consumeScheduledRetrigger(this.options.storage, guildId, channelId);
    {
      // Timer wakes and manual triggers land here directly, so the per-server pause
      // must gate the loop itself, not just the message handler.
      const server = await ensureServer(this.options.storage, guildId);
      if (server.paused) {
        this.options.logger.info("Channel run skipped because server is paused", { guildId, channelId });
        return;
      }
    }
    if (options.initialResponders?.length) {
      const server = await ensureServer(this.options.storage, guildId);
      const channel = server.channels[channelId];
      if (!channelHasWaifus(channel)) {
        this.options.logger.info("Directed channel run stopped because no waifus are enabled for channel", {
          guildId,
          channelId
        });
        return;
      }
      const availableWaifus = await listAvailableWaifusForChannel(this.options.storage, channel);
      const decision: OrchestratorDecision = {
        action: "reply",
        respondingWaifus: options.initialResponders.map((responder) => ({
          waifuId: responder.waifuId,
          delaySeconds: responder.delaySeconds ?? 0,
          directive: responder.directive
            ? { intent: responder.directive.intent as DirectiveIntent, goal: responder.directive.goal ?? "" }
            : undefined,
          replyToMessageId: responder.replyToMessageId
        })),
        reasoning: options.initialReason ?? "Manual directed run."
      };
      const decisionId = randomUUID();
      // Manual directed runs bypass the directive budget entirely (their directives are
      // already "manual" intent and exempt); guardrails are not run here.
      const responderOutcomes = await this.recordOrchestratorDecision({
        guildId,
        channelId,
        decisionId,
        decision,
        status: "pending"
      });
      const { attemptedCount } = await this.executor.executeResponderDecision({
        guildId,
        channelId,
        server,
        channel,
        decision,
        decisionId,
        responderOutcomes,
        decisionDelayBaseMs: Date.now(),
        useDecisionRelativeDelays: true,
        availableWaifus,
        signal
      });
      // A directed turn that produced nothing still hands over to the orchestrator: it has not
      // judged this context yet, so this is not a re-decision loop.
      if (attemptedCount === 0) {
        this.options.logger.info("Directed channel run stopped because no responders were executed", {
          guildId,
          channelId
        });
        return;
      }
    }

    await setActivePipeline(this.options.storage, guildId, channelId, "orchestrator");
    let nothingSent = false;
    while (turns < this.maxAutomaticTurns) {
      throwIfAborted(signal);
      turns += 1;
      const server = await ensureServer(this.options.storage, guildId);
      const channel = server.channels[channelId];
      if (!channelHasWaifus(channel)) {
        this.options.logger.info("Channel runtime loop stopped because no waifus are enabled for channel", {
          guildId,
          channelId
        });
        return;
      }

      const orchestrator = await readAgentConfig(this.options.storage, "orchestrator", ORCHESTRATOR_DEFAULT_WINDOW);
      // Deterministic when: no global model configured (free mode), or this guild explicitly
      // opted its channels into the model-free structural decider.
      const oneShotMode = server.orchestratorMode === "one-shot";
      const deterministicMode = server.orchestratorMode === "deterministic" || (!oneShotMode && !orchestrator.modelId);
      const mode: OrchestratorMode = oneShotMode ? "one-shot" : deterministicMode ? "deterministic" : "model";
      const modelConfig =
        mode === "model" ? { providerId: orchestrator.providerId, modelId: orchestrator.modelId! } : undefined;
      const pipeline = modelConfig ? this.models.pipelineFor(modelConfig, "orchestrator") : undefined;
      if (pipeline && !pipeline.decideOrchestrator) {
        throw new Error(`Model ${orchestrator.modelId} does not implement orchestrator decisions.`);
      }
      const availableWaifus = await listAvailableWaifusForChannel(this.options.storage, channel);
      const { cast: deterministicCast, nicknames: guildNicknames } = await buildDeterministicCast(
        this.options.storage,
        guildId,
        availableWaifus
      );
      const pastDecisions = await readCompletedOrchestratorDecisionsForChannel(this.options.storage, guildId, channelId);
      const requireReply = Boolean(options.firstOrchestratorMustReply && turns === 1);
      const channelKey = timerKey(guildId, channelId);
      const directiveCount = this.directiveDecisionCounts.get(channelKey) ?? orchestrator.directiveCooldown;

      // On the first turn of a timer-fired retrigger, surface the wake marker (with the wake plan
      // the orchestrator promised last time) so it can pick up where it left off, plus escalate the
      // next backoff if it chooses no_reply again. Only a wake armed by a no_reply decision gets
      // a marker, and it describes THAT decision (B8: the decision id recorded with the timer) —
      // turn-limit cooldowns, crash recovery and suppressed wakes have no plan to execute.
      const wakeDecision =
        turns === 1 && options.trigger === "retrigger" ? wakeSchedulingDecision(options.wake, pastDecisions) : undefined;
      // The armed delay (includes earlier escalation) when known, else the decision's own number.
      const timerWakeSeconds = wakeDecision ? options.wake?.seconds ?? wakeDecision.retriggerAfterSeconds : undefined;

      // The director's context (spec 8.7): one cursor-bounded, append-only transcript for every
      // mode — the model reads it as a prompt, deterministic and one-shot read the same entries.
      const resolvedModel = modelConfig ? this.models.resolvedModel(modelConfig) : undefined;
      const model = resolvedModel ?? structuralModel(mode, modelConfig?.modelId ?? server.oneShot.target);
      const isWaifu = await this.waifuAuthorMatcher(deterministicCast);
      const backfillCap = resolveContextCap("orchestrator", server, orchestrator);
      const renderer = createOrchestratorRenderer({
        mode,
        cast: buildCastCards(availableWaifus, guildNicknames),
        availableWaifuIds: availableWaifus.map((waifu) => waifu.id),
        place: orchestratorPlace(server.name, channel.name, channelId),
        pausePlanning: orchestrator.promptSections.pausePlanning,
        ownerPolicy: orchestrator.prompt,
        turn: {
          replyRequired: requireReply,
          directiveCount,
          directiveCooldown: orchestrator.directiveCooldown,
          pastDecisions,
          ...(wakeDecision && timerWakeSeconds
            ? {
                wake: {
                  scheduledSeconds: timerWakeSeconds,
                  ...(wakeDecision.wakePlan ? { wakePlan: wakeDecision.wakePlan } : {}),
                  decidedAt: wakeDecision.createdAt
                }
              }
            : {})
        },
        conversation: { guildId, channelId },
        isWaifu
      });
      const conversation = { kind: "guild" as const, guildId, channelId };
      const attribution: ModelCallAttribution = {
        purpose: "orchestrator",
        agentId: "orchestrator",
        guildId,
        channelId,
        conversationKey: conversationKey(conversation)
      };
      // The orchestrator usually reconciles a new message first, freezing its ledger render for
      // every agent: it needs the same mention/role/channel/emoji names as the waifu path.
      const directory = await loadGuildDirectoryView(this.options.storage, guildId, {
        channelName: (id) => server.channels[id]?.name
      });
      const prepared = await this.options.contexts.prepare({
        conversation,
        agent: ORCHESTRATOR_AGENT,
        model,
        backfillCap,
        selfAuthorIds: [],
        render: renderer,
        signal,
        params: orchestrator.params,
        server,
        directory,
        // Own-model compaction mirrors the decision call (T7b contract): forced tool choice (mapped
        // to none/auto for summarizing), same sampling, params and attribution. Deterministic and
        // one-shot passes have no summarizer: their context truncates durably instead.
        ...(pipeline?.summarizeContext
          ? {
              summarize: contextSummarizer(pipeline, {
                toolChoice: { name: ORCHESTRATOR_TOOL_NAME },
                temperature: ORCHESTRATOR_TEMPERATURE,
                params: orchestrator.params,
                attribution
              })
            }
          : {}),
        // One-shot reads a small window (its old ~20 messages); deterministic keeps keepRecent.
        ...(oneShotMode ? { truncateKeep: backfillCap } : {}),
        // Past decisions always render as text lines, never as assistant tool_use turns: a Claude
        // model with thinking on rejects (400) a replayed tool_use that has no thinking block, the
        // JSON-schema fallback sends no tools at all, and one fixed rendering keeps the prefix stable
        // when the model or its reasoning params change.
        renderToolTurnsAsText: true
      });
      const assessment =
        renderer.assessment() ??
        assessOrchestratorTurn(
          ledgerToContextMessages(prepared.transcript, { guildId, channelId, isWaifu }),
          { directiveCount, directiveCooldown: orchestrator.directiveCooldown, pastDecisions },
          prepared.startedAt
        );
      const messages = assessment.messages;
      await noteActiveChatParticipantsFromContext(this.options.storage, guildId, channelId, messages);
      // Structural deciders (deterministic, one-shot, fallbacks, overrides) read the newest window
      // only, the same size they always had; the transcript itself may be longer.
      let recent = messages.slice(-backfillCap);
      if (oneShotMode && this.options.ocr) recent = await this.options.ocr.enrichMessages(recent, { signal });
      this.options.logger.info("Prepared orchestrator context", {
        guildId,
        channelId,
        mode,
        transcriptCount: prepared.prompt.transcriptCount,
        estimatedTokens: prepared.prompt.estimatedTokens,
        modelId: oneShotMode ? server.oneShot.target : orchestrator.modelId
      });
      // Cast-only beat budget: a timer wake must not milk a beat the cast already covered.
      // When the humans are silent and several unanswered waifu messages already trail the
      // context, skip the model pass and check back later — unless the room has been quiet
      // long enough that a genuinely fresh beat is welcome.
      if (turns === 1 && options.trigger === "retrigger" && options.wake?.source !== "preempted") {
        const suppressed = shouldSuppressCastWake(messages, Date.now());
        if (suppressed) {
          this.options.logger.info("Cast-only wake suppressed; beat budget exhausted", {
            guildId,
            channelId,
            trailingBotMessages: suppressed.trailingBotMessages
          });
          await this.scheduleRetrigger(guildId, channelId, CAST_WAKE_SUPPRESS_SECONDS, { source: "cast_wake_suppressed" });
          return;
        }
      }

      const { loop, humanActiveNow, directiveBudgetOpen } = assessment;
      // No typing scope for orchestrator decisions: the orchestrator bot showing "typing…" while it
      // deliberates leaks the machinery's presence into the room. Only the waifu send path types.
      let decision: OrchestratorDecision;
      let semanticLoopDetected = false;
      let usage: Usage | undefined;
      if (oneShotMode) {
        try {
          const before = performance.now();
          const result = await (this.options.decideOneShot ?? ((input) => this.oneShot.decide(input)))({
            target: server.oneShot.target, messages: recent, cast: deterministicCast, waifus: availableWaifus, now: new Date(),
            timeZone: prepared.state.timeZone,
            replyRequired: requireReply, directiveBudgetOpen, loopSuspected: loop.suspected, timerWakeSeconds,
            policy: orchestrator.prompt, signal,
            attribution: { guildId, channelId, conversationKey: attribution.conversationKey }
          });
          decision = result.decision;
          semanticLoopDetected = result.loopDetected;
          this.options.logger.info("One shot decision completed", { guildId, channelId, target: server.oneShot.target,
            action: decision.action, loopDetected: semanticLoopDetected, durationMs: Math.round(performance.now() - before) });
        } catch (error) {
          if (requireReply || signal.aborted) throw error;
          decision = decideDeterministically({ messages: recent, cast: deterministicCast, now: new Date() });
          const code = error instanceof Error && /^one_shot_[a-z0-9_]+$/.test(error.message) ? error.message : "one_shot_failed";
          this.options.logger.warn("One shot failed; deterministic fallback decision used", { guildId, channelId, code, action: decision.action });
        }
      } else if (!pipeline || !pipeline.decideOrchestrator) {
        decision = decideDeterministically({ messages: recent, cast: deterministicCast, now: new Date() });
        this.options.logger.info("Deterministic orchestrator decision (no model configured)", {
          guildId,
          channelId,
          action: decision.action,
          reasoning: decision.reasoning
        });
      } else {
        const decide = pipeline.decideOrchestrator.bind(pipeline);
        try {
          decision = await this.options.contexts.call(prepared, (prompt) =>
            decide({
              modelId: orchestrator.modelId!,
              messages,
              prompt,
              transcript: prepared.transcript,
              availableWaifuIds: availableWaifus.map((waifu) => waifu.id),
              replyRequired: requireReply,
              temperature: ORCHESTRATOR_TEMPERATURE,
              params: orchestrator.params,
              signal,
              attribution: { ...attribution, conversationKey: prepared.key },
              onUsage: (reported) => {
                usage = reported;
              }
            })
          );
        } catch (error) {
          if (signal.aborted) throw error;
          // Manual /run promised the user a reply: a decision that came back unusable (unparsable,
          // invalid or truncated) becomes the enforced structural reply below; a provider failure
          // (network, quota, …) still surfaces.
          if (requireReply && !isDecisionShapeError(error)) throw error;
          decision = decideDeterministically({ messages: recent, cast: deterministicCast, now: new Date() });
          this.options.logger.warn("Model orchestrator failed; deterministic fallback decision used", {
            guildId,
            channelId,
            message: error instanceof Error ? error.message : String(error),
            action: decision.action,
            reasoning: decision.reasoning
          });
        }
      }
      // Reply-required is enforced in code (the tool schema is stable per channel config): a
      // manual /run that came back with a pause still gets a voice.
      if (requireReply && decision.action !== "reply") {
        const forced = forceReplyDecision({ messages: recent, cast: deterministicCast, now: new Date() });
        if (forced) {
          this.options.logger.warn("Reply required: the decision paused; a deterministic reply is used", {
            guildId,
            channelId,
            modelReasoning: decision.reasoning.slice(0, 140),
            responder: forced.respondingWaifus[0]?.waifuId
          });
          decision = forced;
        }
      }
      // Wake-plan enforcement: this pass IS the wake a no_reply plan scheduled. If the model
      // answers no_reply again — its second consecutive plan with no execution — the runtime
      // executes the promised plan itself (named waifu + the plan text as her change_topic
      // goal). Live 2026-07-06 08:11: "have Lumi start a new topic" → no_reply restating it.
      let wakePlanEnforced = false;
      if (
        !deterministicMode &&
        !oneShotMode &&
        !requireReply &&
        timerWakeSeconds &&
        wakeDecision?.wakePlan &&
        decision.action === "no_reply" &&
        pastDecisions[0]?.id === wakeDecision.id
      ) {
        const enforced = enforceWakePlan({
          plan: wakeDecision.wakePlan,
          cast: deterministicCast,
          messages: recent,
          now: new Date()
        });
        if (enforced) {
          this.options.logger.warn("Wake-plan enforcement: model deferred its own plan twice; executing it", {
            guildId,
            channelId,
            plan: wakeDecision.wakePlan.slice(0, 140),
            executor: enforced.respondingWaifus[0]?.waifuId,
            modelReasoning: decision.reasoning.slice(0, 140)
          });
          decision = enforced;
          wakePlanEnforced = true;
        }
      }
      // Waiting-human rule (spec 8.7 policy 2, enforced as the director prompt states it): a human
      // wrote in the last 15 minutes and the model pauses anyway (live 2026-07-06 06:07: "the
      // conversation is still very active, but…" → no_reply 45). The structural decider replies
      // when the newest message is that human's and someone is available; the model resumes
      // control next pass.
      if (!deterministicMode && !requireReply && humanActiveNow && decision.action === "no_reply") {
        const override = decideDeterministically({ messages: recent, cast: deterministicCast, now: new Date() });
        if (override.action === "reply") {
          this.options.logger.warn("Waiting-human override: the model paused on a human's message; deterministic reply used", {
            guildId,
            channelId,
            modelReasoning: decision.reasoning.slice(0, 160),
            override: override.reasoning
          });
          decision = override;
        }
      }
      decision = capDecisionDelays(decision);
      if (requireReply) {
        decision = applyFirstResponderDirectiveOverride(
          decision,
          options.firstResponderSceneDirectionOverride
        );
      }
      const decisionDelayBaseMs = Date.now();
      const useDecisionRelativeDelays = hasRecentUserMessage(messages, 4);
      for (const message of messages) {
        if (message.authorKind === "user" && message.authorBot !== true) {
          if (!lastHumanMessageTs || message.timestamp > lastHumanMessageTs) {
            lastHumanMessageTs = message.timestamp;
          }
        }
      }
      const decisionId = randomUUID();
      const initialDecisionStatus: OrchestratorDecisionStatus =
        decision.action === "reply" ? "pending" : "completed";
      // Record history with the ORIGINAL decision (the dashboard shows what the model wanted), but
      // execute the guarded decision (stripped directives over budget/cap).
      const guarded = this.applyDirectiveGuardrails({
        guildId,
        channelId,
        decision,
        directiveCooldown: orchestrator.directiveCooldown,
        // wake-plan enforcement exists to fire a directive — it must not be budget-stripped
        loopSuspected: loop.suspected || semanticLoopDetected || wakePlanEnforced
      });
      const responderOutcomes = await this.recordOrchestratorDecision({
        guildId,
        channelId,
        decisionId,
        decision,
        status: initialDecisionStatus
      });
      for (const strippedEntry of guarded.stripped) {
        const outcome = responderOutcomes[strippedEntry.index];
        if (outcome) {
          await updateOrchestratorResponderOutcome(this.options.storage, decisionId, outcome.id, {
            directiveStripped: strippedEntry.reason
          });
          this.options.logger.info("Stripped orchestrator directive", {
            guildId,
            channelId,
            waifuId: outcome.waifuId,
            reason: strippedEntry.reason
          });
        }
      }
      void sendOrchestratorDebugLog(this.options, {
        guildId,
        channelId,
        decision,
        availableWaifus
      });

      if (decision.action === "no_reply") {
        // A pause is final the moment it is recorded.
        await this.commitDecision(prepared, decisionId, usage);
        let seconds = decision.retriggerAfterSeconds ?? RETRIGGER_DEFAULT_SECONDS;
        if (timerWakeSeconds) {
          seconds = Math.max(seconds, Math.ceil(timerWakeSeconds * 1.5));
        }
        await this.scheduleRetrigger(guildId, channelId, seconds, { source: "no_reply", decisionId });
        return;
      }

      let execution: { attemptedCount: number; executedCount: number };
      try {
        execution = await this.executor.executeResponderDecision({
          guildId,
          channelId,
          server,
          channel,
          decision: guarded.decision,
          decisionId,
          responderOutcomes,
          decisionDelayBaseMs,
          useDecisionRelativeDelays,
          availableWaifus,
          signal
        });
      } finally {
        // The executor has finalized the decision (completed / interrupted / failed) by now, so its
        // note carries the real outcome; a decision still pending is never rendered.
        await this.commitDecision(prepared, decisionId, usage);
      }
      const { attemptedCount, executedCount } = execution;
      if (attemptedCount === 0) {
        this.options.logger.info("Channel runtime loop stopped because no responders were executed", {
          guildId,
          channelId
        });
        return;
      }
      if (executedCount === 0) {
        // Every responder came back empty/blocked: nothing changed in the room, so another pass
        // would re-decide on the same context (up to maxAutomaticTurns times). End the burst and
        // fall through to the normal cooldown wake instead.
        this.options.logger.warn("No responder sent anything; ending pass loop until the cooldown wake", {
          guildId,
          channelId,
          turns
        });
        nothingSent = true;
        break;
      }
      await setActivePipeline(this.options.storage, guildId, channelId, "orchestrator");
    }
    // Cast-only pacing: when no human has spoken recently, the room can idle far longer
    // between automatic bursts — this is also the API-credit throttle for self-chatter.
    const humanRecent =
      lastHumanMessageTs !== undefined &&
      Date.now() - Date.parse(lastHumanMessageTs) < HUMAN_RECENT_WINDOW_MS;
    const cooldownSeconds = humanRecent ? RETRIGGER_DEFAULT_SECONDS : CAST_ONLY_COOLDOWN_SECONDS;
    if (!nothingSent) {
      this.options.logger.warn("Automatic turn limit reached; scheduling cooldown", {
        guildId,
        channelId,
        maxAutomaticTurns: this.maxAutomaticTurns,
        humanRecent,
        cooldownSeconds
      });
    }
    await this.scheduleRetrigger(guildId, channelId, cooldownSeconds, {
      source: nothingSent ? "nothing_sent" : "turn_limit"
    });
  }

  /**
   * Waifu authorship for ledger entries: every configured waifu's bot author ids (not only this
   * channel's cast, so a waifu disabled here still never counts as a human), plus cast names for
   * bot entries whose id is unknown.
   */
  private async waifuAuthorMatcher(cast: DeterministicCastMember[]): Promise<(entry: LedgerEntry) => boolean> {
    const [waifus, bots] = await Promise.all([listWaifus(this.options.storage), readDiscordBotsFile(this.options.storage)]);
    return waifuAuthorMatcher({
      authorIds: [
        ...waifus.flatMap((waifu) => resolveBotAuthorIds(waifu.botId, bots)),
        ...cast.flatMap((member) => member.authorIds)
      ],
      names: [
        ...waifus.flatMap((waifu) => [waifu.name, waifu.displayName]),
        ...cast.flatMap((member) => member.names)
      ]
    });
  }

  /**
   * Commit the pass to the director's context once its decision is final (spec 8.7): the
   * request's breakpoint and usage, plus the decision as a frozen `decision` note anchored to the
   * newest ledger entry at this moment. The note write is a locked update of the current state, so
   * it never conflicts with a concurrent prepare (that prepare sees the new revision and rebuilds).
   * A decision still pending (its finalization failed) is never rendered. Best-effort: a failed
   * write only costs the director this one note.
   */
  private async commitDecision(prepared: PreparedContext, decisionId: string, usage: Usage | undefined): Promise<void> {
    try {
      const entry = await readOrchestratorDecision(this.options.storage, decisionId);
      // Name the messages the decision produced by their refs (assigned now if they have not
      // reached the ledger yet; refs are stable per conversation), so the note's place in the
      // transcript does not matter.
      const produced = (entry?.responderOutcomes ?? []).filter((outcome) => outcome.status === "sent").flatMap((outcome) => outcome.messageIds);
      const refs = produced.length ? await this.options.contexts.assignRefs(prepared.conversation, produced) : new Map<string, string>();
      const note = entry ? decisionNoteFor(entry, (messageId) => refs.get(messageId)) : undefined;
      await this.options.contexts.commit(prepared, {
        notes: note ? [note] : [],
        ...(usage ? { usage } : {}),
        modelKey: prepared.modelKey
      });
    } catch (error) {
      this.options.logger.warn("Failed to commit the orchestrator decision to its context", {
        conversationKey: prepared.key,
        decisionId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private applyDirectiveGuardrails(input: {
    guildId: string;
    channelId: string;
    decision: OrchestratorDecision;
    directiveCooldown: number;
    loopSuspected: boolean;
  }): { decision: OrchestratorDecision; stripped: Array<{ index: number; reason: "cooldown" | "over_cap" }> } {
    const key = timerKey(input.guildId, input.channelId);
    const current = this.directiveDecisionCounts.get(key) ?? input.directiveCooldown;
    const budgetOpen = input.loopSuspected || current >= input.directiveCooldown;
    const stripped: Array<{ index: number; reason: "cooldown" | "over_cap" }> = [];
    let honored = false;
    const respondingWaifus = input.decision.respondingWaifus.map((responder, index) => {
      const directive = responder.directive;
      if (!directive) return responder;
      if (directive.intent === "manual") {
        honored = true;
        return responder;
      }
      if (directive.goal.length > DIRECTIVE_GOAL_MAX_CHARS) {
        stripped.push({ index, reason: "over_cap" });
        return { ...responder, directive: undefined };
      }
      if (!budgetOpen) {
        stripped.push({ index, reason: "cooldown" });
        return { ...responder, directive: undefined };
      }
      honored = true;
      return responder;
    });
    // Cap at a large sentinel purely to prevent unbounded growth on long-lived channels.
    this.directiveDecisionCounts.set(key, honored ? 0 : Math.min(current + 1, 1000));
    return { decision: { ...input.decision, respondingWaifus }, stripped };
  }

  private async recordOrchestratorDecision(input: {
    guildId: string;
    channelId: string;
    decisionId: string;
    decision: OrchestratorDecision;
    status: OrchestratorDecisionStatus;
  }): Promise<OrchestratorResponderOutcome[]> {
    const responderOutcomes = input.decision.respondingWaifus.map(
      (responder): OrchestratorResponderOutcome => ({
        id: randomUUID(),
        waifuId: responder.waifuId,
        source: "orchestrator",
        status: "pending",
        messageIds: []
      })
    );
    await appendOrchestratorHistory(this.options.storage, {
      id: input.decisionId,
      guildId: input.guildId,
      channelId: input.channelId,
      action: input.decision.action,
      respondingWaifus: input.decision.respondingWaifus,
      retriggerAfterSeconds: input.decision.retriggerAfterSeconds,
      wakePlan: input.decision.wakePlan,
      reasoning: input.decision.reasoning,
      status: input.status,
      waifuMessageIds: [],
      responderOutcomes,
      createdAt: nowIso()
    });
    this.options.logger.info("Orchestrator decision recorded", {
      guildId: input.guildId,
      channelId: input.channelId,
      action: input.decision.action,
      responders: input.decision.respondingWaifus.map((entry) => entry.waifuId),
      retriggerAfterSeconds: input.decision.retriggerAfterSeconds,
      reasoning: input.decision.reasoning
    });
    return responderOutcomes;
  }

  // wake records who armed the timer (persisted with it, so a restored timer keeps its identity);
  // undefined only when restoring a timer persisted before sources were recorded.
  async scheduleRetrigger(
    guildId: string,
    channelId: string,
    seconds: number,
    wake: RetriggerWakeInput | undefined
  ): Promise<void> {
    const bounded = Math.max(RETRIGGER_MIN_SECONDS, Math.min(RETRIGGER_MAX_SECONDS, seconds));
    const key = timerKey(guildId, channelId);
    const at = new Date(Date.now() + bounded * 1000).toISOString();
    const scheduled: RetriggerWake | undefined = wake
      ? { source: wake.source, seconds: wake.seconds ?? bounded, ...(wake.decisionId ? { decisionId: wake.decisionId } : {}) }
      : undefined;
    const versionAtStart = this.channelRunVersions.get(key) ?? 0;
    await updateSession(this.options.storage, guildId, channelId, (current) => {
      const { scheduledRetrigger: _previous, ...rest } = current;
      return {
        ...rest,
        scheduledRetriggerAt: at,
        ...(scheduled ? { scheduledRetrigger: scheduled } : {}),
        activePipeline: null
      };
    });
    // The write awaited; never arm a timer the world moved past meanwhile. Paused/stopping keeps
    // the persisted wake (resume / next boot restores it). A /stop or a newer run for this
    // channel (both bump the channel version) supersedes it entirely, so drop our write too.
    if (this.hooks.isStopping() || this.options.isPaused?.()) return;
    if ((this.channelRunVersions.get(key) ?? 0) !== versionAtStart) {
      await updateSession(this.options.storage, guildId, channelId, (current) => {
        if (current.scheduledRetriggerAt !== at) return current;
        const { scheduledRetriggerAt: _at, scheduledRetrigger: _wake, ...rest } = current;
        return rest;
      });
      return;
    }
    const existing = this.retriggerTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.retriggerTimers.delete(key);
      this.startChannelRunBackground(guildId, channelId, "scheduled-retrigger", { trigger: "retrigger", wake: scheduled });
    }, bounded * 1000);
    this.retriggerTimers.set(key, timer);
  }

  clearRetriggerTimer(guildId: string, channelId: string): boolean {
    const key = timerKey(guildId, channelId);
    const timer = this.retriggerTimers.get(key);
    if (!timer) return false;
    clearTimeout(timer);
    this.retriggerTimers.delete(key);
    return true;
  }
}

function capDecisionDelays(decision: OrchestratorDecision): OrchestratorDecision {
  return {
    ...decision,
    respondingWaifus: decision.respondingWaifus.map((responder) => ({
      ...responder,
      delaySeconds: Math.min(responder.delaySeconds, MAX_WAIFU_DELAY_SECONDS)
    }))
  };
}

function applyFirstResponderDirectiveOverride(
  decision: OrchestratorDecision,
  sceneDirection: string | undefined
): OrchestratorDecision {
  const trimmed = sceneDirection?.trim();
  if (!trimmed || decision.action !== "reply" || decision.respondingWaifus.length === 0) {
    return decision;
  }
  return {
    ...decision,
    respondingWaifus: decision.respondingWaifus.map((responder, index) =>
      index === 0
        ? { ...responder, directive: { intent: "manual" as const, goal: trimmed } }
        : responder
    )
  };
}

const HUMAN_RECENT_WINDOW_MS = 15 * 60 * 1000;

const ORCHESTRATOR_AGENT: ContextAgent = { kind: "orchestrator" };

/** The orchestrator agent's default backfill window when no config file exists (same as the API). */
const ORCHESTRATOR_DEFAULT_WINDOW = 20;

/** Decision-call temperature; the summarizer mirrors it so compaction reuses the same request shape. */
const ORCHESTRATOR_TEMPERATURE = 0.2;

/**
 * Capability stand-in for passes that make no chat-model call (deterministic, one-shot) or whose
 * model the gateway registry cannot resolve: text-only (images freeze to their OCR text), and a
 * context window large enough that only compaction's message cap applies. It deliberately has no
 * `features`/`params`: only the context engine's budget (limits) and image rule (modalities) read
 * it; compaction never sees it (summary-less contexts truncate, and a summarizer always uses its
 * pipeline's own gateway model).
 */
function structuralModel(mode: OrchestratorMode, modelId: string): ResolvedModel {
  return {
    providerId: mode === "model" ? "unresolved" : "structural",
    modelId: mode === "model" ? modelId : mode === "one-shot" ? `one-shot:${modelId}` : "deterministic",
    limits: { contextTokens: 1_000_000, maxOutputTokens: 4096 },
    modalities: { input: ["text"], output: ["text"] }
  } as unknown as ResolvedModel;
}

/**
 * A decision call that came back but is unusable (unparsable / invalid arguments, a structured
 * decision that did not complete, or one truncated by the output cap), as opposed to a provider
 * failure. On a reply-required /run these become the enforced structural reply.
 */
function isDecisionShapeError(error: unknown): boolean {
  if (error instanceof TruncatedOutputError) return true;
  return error instanceof GatewayPipelineError && /^(decideOrchestrator:|Structured decision did not complete)/.test(error.message);
}

const RECOVERY_RETRIGGER_SECONDS = 180;

const RECOVERY_RETRIGGER_MAX_SECONDS = 2 * 60 * 60;

// A preempted channel gets its turn back promptly once the guild's run slot frees.
const PREEMPTED_RETRIGGER_SECONDS = RETRIGGER_MIN_SECONDS;

/** Crash-recovery wake for the nth consecutive failed run: 3m, 6m, 12m, … capped at 2h. */
function recoveryRetriggerSeconds(attempt: number): number {
  return Math.min(RECOVERY_RETRIGGER_MAX_SECONDS, RECOVERY_RETRIGGER_SECONDS * 2 ** Math.max(0, attempt - 1));
}

// The no_reply decision that armed this wake, if any. Timers armed by anything else (turn-limit
// cooldown, crash recovery, suppressed wakes, preemption, boot catch-up) have no plan to execute.
function wakeSchedulingDecision(
  wake: RetriggerWakeInput | undefined,
  pastDecisions: OrchestratorDecisionHistoryEntry[]
): OrchestratorDecisionHistoryEntry | undefined {
  if (wake) {
    if (wake.source !== "no_reply" || !wake.decisionId) return undefined;
    return pastDecisions.find((entry) => entry.id === wake.decisionId && entry.action === "no_reply");
  }
  // Timer persisted before sources were recorded (or an external retrigger call): only trust the
  // newest completed decision, and only when it is itself a no_reply that would have armed it.
  const newest = pastDecisions[0];
  return newest?.action === "no_reply" ? newest : undefined;
}

const CAST_ONLY_COOLDOWN_SECONDS = 900;

const CAST_WAKE_MAX_TRAILING_BOT_MESSAGES = 4;

const CAST_WAKE_HUMAN_RECENT_MS = 30 * 60 * 1000;

const CAST_WAKE_FRESH_BEAT_MS = 2 * 60 * 60 * 1000;

const CAST_WAKE_SUPPRESS_SECONDS = 1800;

// A wake pass is suppressed when the cast has already stacked unanswered messages on a
// beat (>= CAST_WAKE_MAX_TRAILING_BOT_MESSAGES trailing bot messages, no human inside
// CAST_WAKE_HUMAN_RECENT_MS). A room quiet for CAST_WAKE_FRESH_BEAT_MS or longer is
// exempt: after a long lull a fresh cast beat is welcome again.
function shouldSuppressCastWake(
  messages: ContextMessage[],
  now: number
): { trailingBotMessages: number } | undefined {
  let lastHumanTs: number | undefined;
  let newestTs: number | undefined;
  for (const message of messages) {
    const ts = Date.parse(message.timestamp);
    if (Number.isNaN(ts)) continue;
    if (newestTs === undefined || ts > newestTs) newestTs = ts;
    if (message.authorKind === "user" && message.authorBot !== true) {
      if (lastHumanTs === undefined || ts > lastHumanTs) lastHumanTs = ts;
    }
  }
  let trailingBotMessages = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.authorKind === "user" && message.authorBot !== true) break;
    trailingBotMessages += 1;
  }
  if (trailingBotMessages < CAST_WAKE_MAX_TRAILING_BOT_MESSAGES) return undefined;
  if (lastHumanTs !== undefined && now - lastHumanTs < CAST_WAKE_HUMAN_RECENT_MS) return undefined;
  if (newestTs !== undefined && now - newestTs >= CAST_WAKE_FRESH_BEAT_MS) return undefined;
  return { trailingBotMessages };
}

function hasRecentUserMessage(messages: ContextMessage[], count: number): boolean {
  // Other (non-waifu) bots are authorKind "user" too; only real humans count here.
  return messages.slice(-count).some(isHumanUserMessage);
}
