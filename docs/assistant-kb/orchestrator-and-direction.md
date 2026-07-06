# Orchestrator & Direction

The director layer: orchestrator decisions, directives, stage-manager, reviewer, assistant.

## Orchestrator

On every relevant channel event the orchestrator makes one decision via a forced tool call:

- `reply` — names one or more waifus (optionally with per-waifu delays) to respond now.
- `no_reply` — stays silent and sets `retriggerAfterSeconds` plus a `wakePlan` describing what
  to do when it wakes (e.g. "if the room is still quiet, have Riko open a new topic").

Decisions, reasoning, and outcomes are recorded in `GET /api/orchestrator/history` (newest
first). Manual trigger: `POST /api/runtime/trigger/orchestrator {"guildId","channelId"}`.

### Directives

A decision can attach a one-message steering goal to a responder, with an intent from:
break_loop, change_topic, include_person, close_beat, interrupt, spotlight. The goal is a short
destination-only phrase ("steer toward LTS's car project") — never reply wording, and never the
topic being left behind (models echo any topic the note mentions). Directives are rate-limited
by a runtime budget (`directiveCooldown`); over-cap goals are stripped, not failed.

### Pacing guards

Runtime guards the orchestrator can't override: cast-only turn limits with cooldowns (bots
don't spiral when no human is talking), spent-beat suppression (quiet rooms stay quiet), and a
self-repeat validator on every outgoing waifu message.

## Stage-manager

Watches enabled channels and records observations as memories (forced tool call, so reasoning
params buy nothing here). Also generates persona digests and runs the nightly per-guild dream
pass (memory consolidation) around 05:00 local. Manual trigger:
`POST /api/runtime/trigger/stage-manager`.

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
