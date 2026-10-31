# Private chats (DMs)

Behaviour specific to DMs with a waifu's own bot. Privacy of DM content in the owner's views (D14)
is in [privacy-and-forget.md](privacy-and-forget.md).

## Eligibility

A waifu can receive DMs on a bot only when all hold (`src/orchestration/dm/dmStore.ts`
`computeDmEligibility`):

- she is enabled, has `dm.allowDms` on (default **off**) and a `botId`;
- the bot exists, is not disabled, and is not the House bot;
- she is the **only** enabled waifu on that bot (else warning `dm_bot_shared:<botId>`);
- she has a model (else warning `dm_missing_model:<waifuId>`).

A DM-eligible bot logs in with `Guilds, DirectMessages, DirectMessageReactions,
DirectMessageTyping` (no Message Content intent needed for DMs); every other waifu bot with `Guilds`
only. After a waifu write that changes `dm.allowDms`, `botId` or `enabled`, `reconcileDmIntents()`
re-logs only the bots whose DM set changed. DM-eligible bots register a DM-only `/forget`
(`src/discord/client.ts`).

## When a DM wakes her

- Every inbound DM updates the DM state at once (even while paused): last inbound id/time, display
  name, and clears `undeliverableSince` (`Intake.onDirectMessage`).
- The DM burst fires **2.5 s** after the person's last message (`discord.debounce.dmMs`), later while
  they keep typing (**6 s** per typing event), at most **60 s** after the first message
  (`dmMaxWaitMs`). One `dm` wake per burst, one notification line per message.
- Her wakeup watches on the DM's messages are matched after the hold and ride on the same wake
  (`dm, watch · dm/kevin · "match" · from Kevin · #a3 "…" · your note: "…"`).
- Then the router: rate limit (below) → budget. **Unreleased (on main), §38:** at any hour a DM
  reaches her (no bed time, no busy block, no sleep notice).
  - **Over budget**: deferred until she is under budget again (her next local day), then in the
    budget's batch ([reachability-and-budget.md](reachability-and-budget.md)).
- A DM wake is direct: if she writes text but sends nothing, the unsent-reply nudge runs once.

## Rate limit

`dm.rateLimit` per person per waifu, default **30 replies per 60 minutes** (`maxReplies` 1–1,000,
`windowMinutes` 1–10,080; `null` = unlimited) (`src/orchestration/dm/rateLimit.ts`):

- A **reply** is one turn that sent at least one DM to that person: the first successful send per
  turn per person adds one timestamp; later sends in the same turn add none; automatic notices never
  count (`sendMessageTool`).
- Limited means ≥ `maxReplies` replies in the window `(now − windowMinutes, now]`.
- While limited, her `dm` wakes are **dropped** (not deferred). Watch matches on those messages still
  reach her as plain `watch` wakes.
- With `dm.notifyWhenLimited` (default on), the limit notice is sent **once per limited period** as
  an automatic DM: `dm.limitNotice` (≤ 300 chars; tokens `{name}`, `{user}`, `{retryInMinutes}`), or
  the built-in "I need a little break — talk to you in about {retryInMinutes} minutes!"
  (`DEFAULT_LIMIT_NOTICE`). No model call.
- Counters live in `user/dms/<userId>/limits/<waifuId>.json` (`replyTimestamps` ≤ 1,000,
  `limitNoticeSentAt`, `floorMessageId`, `autoMessageIds` ≤ 50), separate from
  the DM state so a person's `/forget` never resets the limiter.

## No sleep notice any more

**Unreleased (on main), §38:** `dm.sleepNotice` is gone with her bed time (the upgrade archives it;
an old limits file's `sleepNoticeSentFor` is dropped when read). The limit notice is the only
automatic DM. Automatic notices get a ref and show in her `ReadMessages` as `[auto] <text>` (old
sleep notices included).

## When she may write in a DM (D11)

She never cold-DMs anyone. `SendMessage` to `dm/<name>` is allowed only when
(`src/life/tools/messages.ts` `dmSendAllowed`):

1. the person has DMed her before (`lastInboundMessageId`) and the DM is not marked undeliverable;
2. if there is a forget floor, they wrote to her again since it;
3. she is not rate-limited — unless she already sent to them in this turn (a reply is never cut in
   half).

Otherwise `error: you can't post there`. Discord error 50007 marks the DM undeliverable and answers
`they can't receive your messages right now`; their next DM clears it. She may start a conversation
herself in a DM that meets these rules.

DMs appear in her places as `dm/<name-slug>` (`- dm/kevin (Kevin) · last message …` in places.md).

## Discretion

Her `<life>` text says: "What people tell you in private chats is personal; bring it up elsewhere
only if they do." It is guidance, not enforcement: she has one memory across rooms and DMs (D4).
Files from a DM can be attached anywhere at her discretion, except a copy of a DM transcript, which
`SendMessage` refuses.

## Her DM transcripts

Every DM message (both sides) is kept in `/transcripts/dm/<name>/<day>.md`, visible only to that
waifu, forever unless forgotten.

## `/forget` (the person's own)

On a DM-eligible bot, in the DM only (`src/discord/client.ts` `buildDmCommandPayloads`,
`handleDmForgetInteraction`; `src/orchestration/runtime.ts` `handleDmForgetCommand`):

- Option `what`: "this conversation" (`conversation`) or "everything about me" (`everything`).
- An ephemeral question with Confirm/Cancel; it times out after 30 s ("Timed out: nothing was
  forgotten.").
- Done: "Done: I deleted our private chat." (+ "…and everything else I remember about you is marked
  to be forgotten." for `everything`).
- At most once per **6 hours** per person (either scope) runs the life scrub at once; inside the
  window the DM data still goes at once and the life scrub waits for her daily maintenance; her
  turn is never aborted then.

What each scope removes is in [privacy-and-forget.md](privacy-and-forget.md).

## Spec differs

- §4.5's sleep notice is superseded by §38 (no bed time, no sleep notice).
- `src/orchestration/dm/rateLimit.ts`'s header comment says a reply is "one run that sent at least
  one chunk"; the code counts the first DM send per turn per person.
