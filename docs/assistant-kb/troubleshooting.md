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

Expected right now: the Living cast rebuild is in progress and nobody replies yet (the log shows
`Living cast not yet wired (L2)` for each message the runtime accepted). Configuration still works.

When replies return, check in order: `GET /api/status` — is `discord.connected` true and
`waifuBotCount` > 0? Does the channel list at least one waifu (Rooms), and is the server not
`paused`? Does she have a model (`GET /api/runtime` → `models.warnings`) and its provider a key?

## She doesn't answer DMs

Expected right now too (Living cast in progress). Once DMs are answered again, run `list_dms`
(or `GET /api/dms?waifuId=…`) and read the latest run of that conversation:
`rate_limited` / `notice_sent` — the user hit her DM limit (`rateLimit.freesAt` says when it frees;
she answers the next message after that); `undeliverable` — Discord refused the send (error 50007:
the user closed DMs from server members or blocked the bot), retried only after the user writes
again; `blocked` / `empty` — her draft was rejected or empty (not counted against the limit);
`failed` — a model or provider error. No conversation at all means the DM never reached her:
check `GET /api/runtime` → `discord.dm` (is she in `eligibleWaifus`, `intentActive: true`?) and
its warnings: `dm_bot_shared:<botId>` (two enabled waifus on one bot — DMs off for that bot),
`dm_missing_model:<waifuId>`, `dm_intent_pending_reconnect:<botId>` (reload Discord). `dm.allowDms`
must be on for her. While the runtime is paused DMs are recorded but not answered; resuming answers
the ones from the last `discord.dm.resumeWindowMinutes` (60).

## Provider/model 400s

- `model_not_available` on save: the route is not on the curated list (or hidden: the reason is
  in the error and in `GET /api/models` → `hidden`). Pick one from `GET /api/models`.
- `unsupported_effort` on save: that route does not list the effort; the error lists the ones it
  does.
- `models.warnings` in `GET /api/runtime`: `model_unmapped` (the upgrade found no curated
  equivalent of her old model), `effort_dropped` (the installed catalog stopped listing her
  effort), `model_unavailable` (her route is no longer offered): pick a model again.
- DeepSeek "Insufficient Balance": the provider account is out of credits — top up.

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
- Queries/Replies in Activity — the last 100 raw model requests/responses (exact prompts).
- `waifus doctor` — filesystem/config diagnostics.
- Backend log file: `<data-root>/app/logs/backend.log`.

## Images

- "She ignored my picture": an image larger than 3.75 MiB is never sent inline (providers reject
  it), so she sees its OCR text or `[image]`; `discord.images.maxBytes` (default 5 MiB) caps what
  is downloaded at all. See the image settings in the API notes; `ocr.maxImageBytes` /
  `ocr.timeoutMs` are deprecated for fetching.

## Costs and quotas

Every model call writes a line to `user/usage/YYYY-MM-DD.jsonl` (purpose, provider, model, tokens,
cache read and write tokens, cost when known, `status`).

`provider_quota` / `provider_billing` errors mean the provider account is out of quota or credit;
calls to that provider fail fast for 10 / 30 minutes (see `providerAlerts` in `GET /api/runtime`)
instead of retrying. Top up the account; no restart is needed.

## After an upgrade

Data shape changes run at start-up and are recorded in `<data-root>/app/migrations.json`.
Re-running them is always safe (deleting that file just makes them run again with no change).
Living cast L1 (`living-cast-models-v1`): gateway `params`, `contextWindow`, `tools.toolUse` and
`personaDigest` are removed from waifus; each model becomes `model: {providerId, modelId,
effort?}` by family (a model with no curated family is unset and reported in
`GET /api/runtime` → `models.warnings`); provider keys stored under `google-ai-studio` / `qwen`
move to `google` / `alibaba`. Stored efforts are re-checked against the installed catalog at every
start.

## Fast diagnosis tools

- `list_dms` — DM conversations with the rate limit and the latest run: THE tool for "why didn't she answer my DM".
- `get_runtime_status` — includes `discord.warnings` with live per-channel permission failures
  (e.g. "riko cannot send in channel … — check the channel permissions in Discord").
- `list_models` — the curated models with their efforts and whether each provider has a key.
