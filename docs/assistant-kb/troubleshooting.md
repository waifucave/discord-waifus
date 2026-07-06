# Troubleshooting

Common failures, what they look like, and where to look.

## Nothing replies in Discord

Check in order: `GET /api/status` — is `discord.connected` true and `waifuBotCount` > 0?
Is the channel enabled with at least one waifu (Rooms)? Does the orchestrator have a model and
its provider a key? Then read `GET /api/orchestrator/history` — if decisions exist but say
`no_reply`, the director is choosing silence (read its reasoning); if there are no decisions,
the message never reached the runtime (bot lacks channel access or intents).

## Provider/model 400s

- "unsupported_parameter" on save: the model doesn't support that param — the error names the
  violated registry rule.
- "Thinking may not be enabled when tool_choice forces tool use": thinking + forced tool call.
  The app auto-disables thinking on such calls since 1.5.176; if you see this, update.
- DeepSeek "Insufficient Balance": the provider account is out of credits — top up; waifus on
  that provider can't generate until then.
- Repeated Gemini 400s on orchestrator passes: update the app — Google tightened schema
  validation (fixed in gateway 0.1.3/0.1.4).

## Bot connects but a waifu never speaks

Her `botId` must match a Discord bot entry, the bot must be invited to the guild with Message
Content intent, she must be `enabled`, and she must be in the channel's `enabledWaifuIds`.

## Revision conflicts (HTTP 409)

Someone else changed the resource between your read and write. Re-read (GET), reapply your
change on the fresh state, and PUT with the new `revision`.

## Where the evidence lives

- `GET /api/logs?limit=200` — recent backend log entries.
- `GET /api/orchestrator/history` — decisions with reasoning and outcomes.
- Queries/Replies in Activity — the last 100 raw model requests/responses (exact prompts).
- `waifus doctor` — filesystem/config diagnostics.
- Backend log file: `<data-root>/app/logs/backend.log`.

## Messages look wrong (too long, repeated, off-register)

The output harness splits, dedupes, and length-checks replies; persona text should never
contain length/format rules (they don't work there). Self-repeats are blocked automatically.
If a waifu misreads recent context, check Queries for what her prompt actually contained.


## Fast diagnosis tools

- `get_orchestrator_history` — recent decisions with reasoning: THE tool for "why did/didn't she reply".
- `get_runtime_status` — includes `discord.warnings` with live per-channel permission failures
  (e.g. "riko cannot send in channel … — check the channel permissions in Discord").
- If the orchestrator is enabled with no model, that is the free deterministic mode, not a
  misconfiguration.
