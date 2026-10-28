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

Each waifu decides for herself whether to answer: she is woken by mentions, replies, her name,
DMs, her wakeups, or the addressee detector, reads the conversation and may choose to stay
quiet. She also does not wake while asleep in her bed time (only her timed wakeups and your wakes do; while
she dozes or is busy only people talking to her get through), over her daily budget, or while the
server is paused, and a message first waits a moment of quiet (1.5 seconds in a room, 2.5 in a
DM; longer while the person is still typing, at most 10 seconds in a room and a minute in a DM).

If nothing ever replies, check in order: `GET /api/status` — is `discord.connected` true and
`waifuBotCount` > 0? Does the channel list at least one waifu (Rooms), and is the server not
`paused`? Does she have a model (`GET /api/runtime` → `models.warnings`) and its provider a key?
Then look at her life: the dashboard's Life screen, `waifus life <id> --log` or
`GET /api/waifus/:id/life` show whether she was woken, whether wakes wait (asleep, over budget)
and what she did in her last turns (she may have read the room and chosen to stay quiet).

## She doesn't answer DMs

A DM wakes her 2.5 seconds after the last message, longer while the person is still typing (at
most a minute), and she may still
choose not to answer. If she never answers DMs: `dm.allowDms` must be on for her, and `GET /api/runtime` → `discord.dm`
must list her in `eligibleWaifus` with `intentActive: true`. Its warnings name what is wrong:
`dm_bot_shared:<botId>` (two enabled waifus on one bot — DMs off for that bot),
`dm_missing_model:<waifuId>`, `dm_intent_pending_reconnect:<botId>` (reload Discord).

## Provider/model 400s

- `model_not_available` on save: the route is not on the curated list (or hidden: the reason is
  in the error and in `GET /api/models` → `hidden`). Pick one from `GET /api/models`.
- `unsupported_effort` on save: that route does not list the effort; the error lists the ones it
  does.
- `models.warnings` in `GET /api/runtime`: `model_unmapped` (the upgrade found no curated
  equivalent of her old model), `effort_dropped` (the installed catalog stopped listing her
  effort), `model_unavailable` (her route is no longer offered): pick a model again. The first two
  can also be dismissed (Home → Model notices → dismiss, or
  `DELETE /api/runtime/model-warnings/:scope`).
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
- Queries/Replies in Activity — the last 100 model calls. The assistant's and the detector's
  calls keep their content; a life, maintenance, compaction or web call shows only its metadata
  (route, counts, stop reason, usage, cost, timing). Her own life log (Life screen) is where her
  turns are.
- `waifus doctor` — filesystem/config diagnostics and the Living cast's state that needs attention
  (also `GET /api/owner-notices`).
- Backend log file: `<data-root>/app/logs/backend.log`.

## Images

- "She ignored my picture": an image larger than 3.75 MiB is never sent inline (providers reject
  it), so she sees its OCR text or `[image]`; `discord.images.maxBytes` (default 5 MiB) caps what
  is downloaded at all. See the image settings in the API notes; `ocr.maxImageBytes` /
  `ocr.timeoutMs` are deprecated for fetching.

## Costs and quotas

Every model call writes a line to `user/usage/YYYY-MM-DD.jsonl` (purpose, provider, model, tokens,
cache read and write tokens, cost when known, `status`). `GET /api/usage`, `waifus usage` and the
Activity screen's usage tab add them up by local day, waifu, purpose or model. A waifu's
`life.dailyBudgetUsd` stops her ordinary wakes for the rest of the local day once reached.

`provider_quota` / `provider_billing` errors mean the provider account is out of quota or credit;
calls to that provider fail fast for 10 / 30 minutes (see `providerAlerts` in `GET /api/runtime`)
instead of retrying. Top up the account; no restart is needed.

## Owner notices

`GET /api/owner-notices` (Home, `waifus doctor`, `waifus status`) lists what needs the owner:

- a part of a forget that failed three times and was given up (forget the person again to retry);
- a migration step that left an unreadable file alone (it runs again at the next start; fix or
  remove the file it names);
- kept copies of an unreadable forget record (`*.corrupt-<time>`, deleted after 7 days);
- forget scrubs still queued for a waifu (they run when her life next starts or at nightly
  maintenance);
- a waifu linked to a Discord bot that is missing, turned off or has no token (her sends fail;
  a waifu with no bot linked cannot post at all: the House bot never speaks for her).

Review lines are not owner notices: a waifu's review lines (names someone else also has, which a
forget only lists) show as a "review" chip on her Life tile and as a count on Home. Life screen →
Needs review lists them; dismiss each line once checked. Lines from private chats are hidden until
you reveal them on the host itself.

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

- `list_dms` — DM conversations with their rate limit.
- `get_runtime_status` — includes `discord.warnings` with live per-channel permission failures
  (e.g. "yuna cannot send in channel … — check the channel permissions in Discord").
- `list_models` — the curated models with their efforts and whether each provider has a key.
- `get_life` — a waifu's status and recent life log (content from private chats left out).
- `get_usage` — model calls and cost by day, waifu, purpose or model.
- `get_setting_help` — any setting's type, default and bounds.
