# Orchestrator & Direction

The director layer: orchestrator decisions, directives, stage-manager, reviewer, assistant.

## Orchestrator

In LLM mode, each relevant channel event makes a decision through a forced tool call or the
gateway's required JSON-schema path:

- `reply` — names one or more waifus (optionally with per-waifu delays) to respond now.
- `no_reply` — stays silent and sets `retriggerAfterSeconds` plus a `wakePlan` describing what
  to do when it wakes (e.g. "if the room is still quiet, have Riko open a new topic").

Decisions, reasoning, and outcomes are recorded in `GET /api/orchestrator/history` (newest
first). Manual trigger: `POST /api/runtime/trigger/orchestrator {"guildId","channelId"}`.

### What the orchestrator sees

It reads the same channel transcript the waifus do (`[14:02 #k3] Kevin: text`, with the same
message refs), one system message of director rules, a frozen header (conversation summary, who
is on the cast, the place) and a per-call tail: the time now, which waifus are available right now
(asleep or busy ones are marked; this is in the tail only, so it never invalidates the cached
prefix), any runtime notice, the recorded plan when it was woken by its own timer, whether a reply
is required, and whether the directive budget is open. The bot account that posts for the
orchestrator is not part of the conversation. Past decisions appear in the transcript as text
lines once they are final (`sent → #a1` shows which messages a decision produced). The owner's
custom orchestrator prompt is appended as `<owner_policy>`.

The rules the code enforces: a human addressing or replying to a waifu gets her reply now (this
one is guidance to the model); if a human spoke in the last 15 minutes a pause is overridden in
code and one voice replies; with no humans the cast gets one beat and then pauses; pause length
scales with how quiet the room is. The orchestrator compacts like a waifu (see waifus.md) using
its own model; since its reply call forces the decision tool, the summary request uses tool
choice `none` where the model supports it, so only the system prompt and tools stay cached for
that one call. Deterministic and one-shot modes have no summarizer: when their window gets too
long the older messages are simply dropped from it (no summary).

### Directives

A decision can attach a one-message steering goal to a responder, with an intent from:
break_loop, change_topic, include_person, close_beat, interrupt, spotlight. The goal is a short
destination-only phrase ("steer toward LTS's car project") — never reply wording, and never the
topic being left behind (models echo any topic the note mentions). Directives are rate-limited
by a runtime budget (`directiveCooldown`); over-cap goals are stripped, not failed. The goal
reaches the waifu in the tail of the very call it steers; once she has replied it is kept in her
transcript as a `<direction>` note, so later turns remember what she was nudged toward.

### Pacing guards

Runtime guards the orchestrator can't override: cast-only turn limits with cooldowns (bots
don't spiral when no human is talking), spent-beat suppression (quiet rooms stay quiet), and a
self-repeat validator on every outgoing waifu message.

## Stage-manager

Watches active channels (those with at least one waifu) and records observations as memories (forced tool call, so reasoning
params buy nothing here). Also generates persona digests and runs the nightly global dream pass
(memory consolidation, round-robin over waifus) around 05:00 local (`memory.dreamHourLocal`).
The observer keeps its own read cursor per conversation instead of a prompt window, so it is
never compacted. Manual trigger:
`POST /api/runtime/trigger/stage-manager {"guildId","channelId"}`.

## Reviewer

Optional post-send check that can delete a flagged waifu message. Configure model + prompt in
Direction → Reviewer; history at `GET /api/reviewer/history`.

## Assistant

The dashboard helper agent (this assistant). Own config at `/api/assistant/config`; when no
model is set it borrows the orchestrator's. It operates the app through the same REST API the
dashboard uses — changes apply immediately, so it confirms destructive actions in chat first.


## Deterministic (free) orchestrator mode

When the orchestrator is enabled with NO model configured, the app orchestrates
deterministically: the next speaker is chosen from structural signals (reply targets, name/nickname
addressing, references, thread participation, rotation, sleep/busy schedules) with zero API spend.
The same decider runs automatically as a fallback whenever the model orchestrator call fails
(provider outage or content block), so a failed call never silences a channel. Limitations: one
speaker per pass, no directives or topic pivots, no content judgment.

## One shot orchestrator mode

`PUT /api/servers/:guildId` accepts `orchestratorMode: "one-shot"` and
`oneShot: {target: "openrouter:cloudflare/clef"}`. This is per-server and does not change the
global director LLM config. Discover available targets and setup status with
`GET /api/orchestrator/one-shot/models` or `list_one_shot_models`; use `update_server` to select
one. OpenAI/OpenRouter use the existing host provider credentials. Yes/no-only models are excluded.

One native-choice inference per pass chooses exactly one available speaker OR a pause, diagnoses
loops, and selects bounded steering. Its state lists each message with an absolute local time
(`time: "HH:MM"`, plus a `date` when it is not today) and the current `now`, never "N seconds
ago". Code prevents contradictory fields, respects availability and
directive budgets, backs off timer wakes, and provides short template goals, not invented model
reasoning or generated wake plans. Character generation still goes through the current gateway.
Automatic failures use deterministic fallback with safe error codes; required manual failures
use the ordinary runtime error path. Existing pacing/cancellation/pause guards still apply.

Laya English/multilingual/typed-decisions are experimental local options requiring the host-local
`DC_WAIFUS_LAYA_PYTHON` setup described in the README. You cannot configure an executable or
download location through this API. No weights or Python are bundled. Clipped contexts fail safe.
The benchmark found false positives and missed real scene stagnation across candidates; a successful
API call is not proof of good orchestration. Never silently switch the user's mode or model.
