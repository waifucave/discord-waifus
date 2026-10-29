// Shapes shared by the runner, probes, metrics, report and grading of the life benchmark.

import type { CallRecord } from "./models.js";

/** One line of a run's `transcript.jsonl`, in the order things happened. `at` is simulated time. */
export type TranscriptEvent =
  | { type: "start"; at: string; runId: string; scenario: string; model: string; variant: string; repeat: number; dryRun: boolean }
  /** A person's message or join, as posted to the fake server. */
  | { type: "people"; at: string; place: string; from: string; text: string; messageId: string; label?: string; replyTo?: string; join?: boolean; attachments?: string[] }
  /** What reached the fake server from her. */
  | { type: "sent"; at: string; place: string; dm: boolean; text: string; messageId: string; replyTo?: string; replyToLabel?: string; files?: string[]; turnId?: string }
  | { type: "reaction"; at: string; place: string; messageId: string; emoji: string; turnId?: string }
  /** A wake the router took (and what it did with it). */
  | { type: "wake"; at: string; reason: string; place?: string; outcome: string; note?: string; fromName?: string; wakeId: string }
  | { type: "detector"; at: string; messageId: string; label?: string; choice: string; chimeIn?: string }
  /** A model call (no content; the content of summaries is in summaries.json). */
  | { type: "call"; at: string; seq: number; purpose: string; turnId?: string; route: string; finish?: string; error?: string; errorMessage?: string; errorStatus?: number; errorCode?: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; costUsd?: number; realMs: number; toolCalls?: string[] }
  /** Her tool calls and their results, from her life log. */
  | { type: "tool_call"; at: string; epoch: number; turnId?: string; id: string; name: string; input: unknown }
  | { type: "tool_result"; at: string; epoch: number; turnId?: string; id: string; isError: boolean; content: string }
  /** Her own text in a turn (not sent to anyone). */
  | { type: "thought"; at: string; epoch: number; turnId?: string; text: string }
  | { type: "notifications"; at: string; epoch: number; turnId?: string; text: string }
  | { type: "compaction"; at: string; fromEpoch: number; toEpoch: number; reason: string; summarized: boolean; summaryId?: string }
  | { type: "maintenance"; at: string; changed: string[]; summaryId?: string }
  | { type: "checkpoint"; at: string; label: string }
  | { type: "log"; at: string; level: string; message: string; context?: string }
  | { type: "end"; at: string; status: RunStatus; realSeconds: number };

export type RunStatus = "done" | "max_usd" | "error";

/** A summary the run made, with exactly what it summarised (spec §33.3). */
export type SummaryCapture = {
  id: string;
  at: string;
  /** rest | cache_rest | self (hers) | compaction (any app-run compaction) | dream (the nightly notes changes) | morning (the overnight batch, no model). */
  kind: "rest" | "cache_rest" | "self" | "compaction" | "dream" | "morning";
  /** The compaction reason when the app summarised (`trigger`, `day`, …). */
  reason?: string;
  fromEpoch?: number;
  toEpoch?: number;
  route?: string;
  /** What the model was given: system blocks and messages (images dropped). Absent for `morning` (no model). */
  input: { system?: string[]; messages?: unknown[]; tools?: unknown[]; text: string };
  /** The model's text (her summary) or, for a dream, the notes it changed. */
  output: string;
  inputChars: number;
  outputChars: number;
  /** Facts the scenario marks must-keep that were stated before this summary: found or missing. */
  facts?: { kept: string[]; missing: string[] };
};

export type ProbeResult = { id: string; kind: string; passed: boolean | null; detail: string };

export type RunMetrics = {
  turns: number;
  toolCalls: number;
  failedCalls: number;
  /** Share of tool uses (a run of calls to one tool in a turn) whose first call succeeded. */
  firstTrySuccess: number | null;
  /** Calls made again to the same tool right after one of it failed, in the same turn. */
  retries: number;
  /** Identical failing calls repeated (the same tool and input failing again). */
  loops: number;
  toolCallsByName: Record<string, { calls: number; failed: number }>;
  messages: number;
  reactions: number;
  medianLineChars: number | null;
  longestLineChars: number | null;
  /** Messages per turn that sent anything. */
  messagesPerSendingTurn: number | null;
  /** The most messages she sent in a row in one place. */
  longestBurst: number;
  probesPassed: number;
  probesScored: number;
  usd: number;
  /** Whole prompts (fresh + cache reads + cache writes). */
  tokensIn: number;
  tokensOut: number;
  /** Cache reads over whole prompts. */
  cacheReadShare: number | null;
  /** Real seconds of model time per turn (her life calls). */
  secondsPerTurn: number | null;
  modelCalls: number;
  failedModelCalls: number;
  usdByPurpose: Record<string, number>;
  compactions: number;
  summaries: number;
  /** Must-keep facts found over facts that were due, across her summaries. */
  factCoverage: number | null;
};

export type RunSummary = {
  runId: string;
  scenario: string;
  model: string;
  variant: string;
  repeat: number;
  dryRun: boolean;
  status: RunStatus;
  error?: string;
  simulated: { from: string; to: string; reached: string };
  realSeconds: number;
  metrics: RunMetrics;
  probes: ProbeResult[];
  gate?: { passed: boolean; why: string };
  /** Judge packet ids made for this run (kept out of the packets themselves). */
  packets?: string[];
  grades?: GradeSummary;
};

export type GradeSummary = {
  chat?: Record<string, number>;
  summaries?: Record<string, number>;
  graders: number;
  flags: string[];
};

export type RunRecord = {
  summary: RunSummary;
  events: TranscriptEvent[];
  summaries: SummaryCapture[];
  calls: CallRecord[];
  home: Record<string, string>;
};
