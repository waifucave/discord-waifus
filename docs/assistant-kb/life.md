# A waifu's life

How to see what a waifu is doing, wake her, compact or reset her life, and forget a person.

## What a life is

Each waifu is an autonomous agent with one continuous life. Things that concern her (a mention, a
reply, her name, a DM, one of her reminders or watches, the addressee detector's pick) arrive as
wakes in her queue. She handles them one turn at a time: she reads, decides what to do, and only
what she sends reaches people. Her life is split into epochs: when it grows long, compaction
summarises it into her `<life_so_far>` and a new epoch starts with her last few turns kept.

## Seeing it

- Dashboard → Life: her status (awake, asleep or busy; idle or mid-turn), her queue, today's cost
  against her budget, and a live timeline of her life log.
- `waifus life <id> [--log]`, or `GET /api/waifus/:id/life` and `GET /api/waifus/:id/life/log`.
- `/print life` and `/print system_prompt` (House bot, owner only) in Discord.

Content from private chats is hidden by default everywhere: a DM notification; every tool call,
result and her own text in a turn that touched a DM (a web search or a room send included); a call
that touched a DM in any other turn; and her summary. The owner can
reveal it on the host itself (the Life screen's reveal toggle, `waifus life --private`,
`includePrivate=1`, `/print … private:true`). Over Remote Access, and for the dashboard assistant,
it stays hidden.

## Acting on it

- **Wake**: an owner wake with an optional note she sees. It skips her sleep and budget. With
  Discord offline it waits in her queue.
- **Compact**: summarise her life now and start a new epoch. Needs Discord connected and a model.
- **Reset**: start a fresh epoch with no summary. Her notes, plans and queued wakes stay; the old
  log is kept for 7 days.
- **Needs review**: after a forget, lines that mention a name someone else also has are listed per
  waifu instead of being removed. Check each one and dismiss it.

## Forgetting a person

`POST /api/people/:userId/forget`, `waifus forget <userId>` or the Life screen's forget form removes
a Discord user from every DM, the member lists, the archive, and scrubs every waifu's life log,
summary, queue and notes. Forget is a best-effort scrub:

- Discord history itself is not deleted, and whatever she already said in rooms stays there.
- Usage-ledger lines and app logs stay (they hold ids only, never text).
- Cached guild images, and any DM image no image index recorded, stay until the disk cache expires
  them (`discord.images.diskCacheTtlHours`, 168 hours by default).
- Anything outside this host, and the 15-minute web page cache, are not touched.
- Name matching is best effort: a name someone else also has is only listed for review.

A part that fails is retried at the next start, at most three times; then it shows as an owner
notice (Home, `waifus doctor`).

## Costs

Every model call is in the usage ledger. `GET /api/usage`, `waifus usage` and Activity → Usage add
it up by local day, waifu, purpose or model. A waifu's `life.dailyBudgetUsd` holds her ordinary
wakes until the next local day once reached.
