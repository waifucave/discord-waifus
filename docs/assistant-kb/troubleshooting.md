# Troubleshooting

Idle-only updates are opt-in under Settings → App or `waifus update --auto on`.
Use `GET /api/updates` or `waifus update --auto status` for sanitized state; `--auto off`
disables automatic checks without changing manual updates. A busy or older/unregistered sibling,
different data root without opt-in, or locked macOS keychain can postpone an update. Never unlock
a keychain by asking for its password in assistant chat. Automatic updates preserve data/pairings,
but a restarted remote gateway needs a new browser session. Remote users cannot change automatic
update settings or use this feature to restart the host process. Source/development installations
are not auto-updated. Native updater-cycle validation is separate from passing fixture tests.

Common failures, what they look like, and where to look.

## Nothing replies in Discord

Check in order: `GET /api/status` — is `discord.connected` true and `waifuBotCount` > 0?
Does the channel list at least one waifu (Rooms), and is the server not `paused`? Does the
orchestrator have a model and its provider a key? Then read `GET /api/orchestrator/history` —
if decisions exist but say `no_reply`, the director is choosing silence (read its reasoning); if there are no decisions,
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

Her `botId` must match a Discord bot entry whose `enabled` is not false, the bot must be invited
to the guild with Message Content intent, she must be `enabled`, and she must be in the channel's
`enabledWaifuIds`.

## Revision conflicts (HTTP 409)

Someone else changed the resource between your read and write. Re-read (GET), reapply your
change on the fresh state, and PUT with the new `revision`.

## Remote Access does not connect

- `helper_missing`: install the normal Discord Waifus package with optional dependencies enabled;
  do not download or bypass an unverified helper manually.
- `helper_signature_invalid` or `helper_incompatible`: update Discord Waifus. The app refuses a
  helper whose signed release, target, capabilities, Worker trust ring, or app-version bounds do
  not match.
- `activation_required`: activate this installation from its protected local Remote Access UI.
- `direct_unavailable` or repeated `reconnecting`: check that both networks permit usable UDP,
  then use Reconnect. Interface changes and roaming are rediscovered automatically, but V1 never
  sends management traffic through a relay.
- Pairing does not appear: confirm that the invitation is still active, use either its full token
  or exact manual code, and compare the safety phrase before the host approves it.
- Intel macOS and Linux ARMv7: remote mode is intentionally deferred beyond V1; ordinary local `waifus start`
  remains available.

`waifus remote status` reports only the remote gateway. Ordinary `waifus status` reports both
roles. A trusted remote can manage the app but cannot stop or restart the host OS process.

## Where the evidence lives

- `GET /api/logs?limit=200` — recent backend log entries.
- `GET /api/orchestrator/history` — decisions with reasoning and outcomes.
- Queries/Replies in Activity — the last 100 raw model requests/responses (exact prompts).
- `waifus doctor` — filesystem/config diagnostics.
- Backend log file: `<data-root>/app/logs/backend.log`.

## Messages look wrong (too long, repeated, off-register)

The output harness splits, dedupes, and length-checks replies; persona text should never
contain length/format rules (they don't work there). Use the waifu's `verbosity` (`terse`,
`chatty`, `expressive`) for length. Self-repeats are blocked automatically. If a waifu misreads
recent context, run `/print` → system prompt in that channel (private reply) or check Queries
for what her prompt actually contained: summary and memories in the header, the transcript lines
`[14:02 #k3] Name: text`, and the per-call tail.

A reply that starts with a stray `[14:02 #k3]` header, a `Name:` prefix or `↩you` is cleaned up
automatically; if it still leaks, the model is copying the transcript format — lower its
temperature or use a stronger model.

## She forgot something, or remembers the wrong thing

- A fact she learned elsewhere should appear in her memory snapshot (`/print` → memories lists
  everything she has, active and archived, except private-chat memories). If it is missing, check
  `GET /api/memories?waifuId=…&q=…&status=archived`: it may have been merged, expired or deduped.
- The snapshot is frozen at the start of a conversation epoch. A memory saved mid-conversation
  shows up after the next compaction, or earlier as a `<memory_note>` when a new person joins or
  the chat strongly matches it.
- Her view of an old conversation is the summary plus the newest messages. If the summary lost
  something important, pin a memory instead of relying on the summary.

## Compaction (long conversations)

- Look for `Context compaction failed` (warning) and `Context compacted` (info) in
  `GET /api/logs`; `Compaction discarded` just means the conversation moved on meanwhile and the
  next prepare retries. After a failure that
  context does not retry automatically for 5 minutes and keeps answering on its current prompt;
  `lastCompaction` in the context state records `ok: false`.
- "She replied slowly after a long chat": the reply waited up to `compaction.waitTimeoutMs`
  (default 6 s) for a summary, then went out on a shortened prompt. Raise or lower it in app
  config `compaction` or per server (`PUT /api/servers/:guildId` `compaction`).
- Summaries use the waifu's own model, so a model with very small output limits can return a cut
  off summary; the app retries once with double the output cap and then keeps the old context
  instead of storing a truncated one.
- `compaction: {enabled: false}` (app or server) stops automatic summaries and truncation, so the
  prompt keeps growing until the model's own limit; use it only to debug.

## Costs look high / prompt caching

Every call writes a line to `user/usage/YYYY-MM-DD.jsonl` (provider, model, tokens, cache read and
write tokens, cost when known, `status`). A healthy Anthropic conversation reads most of its
input from cache after the first turn (`cacheReadTokens` close to `inputTokens`). Cache misses are
expected after more than 5 minutes of quiet, after a compaction (one rewrite, then hits resume)
and when a waifu's persona, tools or model settings change. The orchestrator in a very busy room
sits near 80% because dozens of new messages arrive between its calls.

`provider_quota` / `provider_billing` errors mean the provider account is out of quota or credit;
calls to that provider fail fast for 10 / 30 minutes (see `providerAlerts` in `GET /api/runtime`)
instead of retrying. Top up the account; no restart is needed.

## After an upgrade

Data shape changes run at start-up and are recorded in `<data-root>/app/migrations.json`.
Re-running them is always safe (deleting that file just makes them run again with no change).
Phase 4 migrations: unsupported model params are dropped from waifu/orchestrator/assistant configs,
the prompt layout is removed (a disabled schedule block becomes `scheduleInPrompt: false`),
memories become global (guild/channel move into `origin`, names into `subjects`, and duplicates
across servers are merged once), and the old URL-keyed OCR cache is deleted.


## Fast diagnosis tools

- `get_orchestrator_history` — recent decisions with reasoning: THE tool for "why did/didn't she reply".
- `get_runtime_status` — includes `discord.warnings` with live per-channel permission failures
  (e.g. "riko cannot send in channel … — check the channel permissions in Discord").
- If the orchestrator is enabled with no model, that is the free deterministic mode, not a
  misconfiguration.
