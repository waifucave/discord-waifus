# Memory

How waifus remember: one global memory per waifu, retrieval, pinning, the observer and dreams.

## Global memory

Each waifu has ONE memory space across every server and (from Phase 5) her DMs. A fact she
learned in one server is available to her in every other server. Where a memory was learned is
kept only as provenance (`origin: { guildId?, channelId?, dm? }`) — it never hides a memory.
Memories learned in a private chat render as "learned in a private chat", and `/print memories`
never prints them into a server channel.

## The store

One store (`user/memories.json`) of MemoryRecords for the whole cast. Each record has:
`content`, `kind` (fact / preference / relationship / event / commitment / context), `waifuId`
(the owner), `subjects` (who it is about: `{ discordUserId? | waifuId?, name }`, names refreshed
from the member cache when rendered), `origin`, `strength` (0–5), `pinned` (user-managed, never
auto-edited), a per-record `revision`, `status` (`active` / `archived`, with `archivedReason`
merged / expired / deduped / user / unknown_waifu and `mergedInto` for merges) and timestamps.
Sources: the stage-manager observer, waifu in-chat `add_memory` notes (72 h unless the dream
promotes them), the nightly dream, and manual entries. Every writer goes through one dedupe gate
(same waifu, overlapping subjects, near-identical text); for manual entries it only reports
`duplicateOf` and never blocks.

## Retrieval

At the start of a conversation epoch a waifu gets a snapshot of up to `memoryInjectionLimit`
memories (pinned capped at `memory.maxPinnedInjected`, default 6), scored by: who is present
(strongest), word overlap with the recent chat (human lines weigh more than her own; works for
accents and CJK), recency, strength, a small same-place boost, and a penalty for memories she was
already shown in the last 24 h. People who join mid-conversation get a few appended memory
notes (`memory.maxMemoryNotesPerEpoch`, default 6).

## Observer and dreams

- **Observer** (per channel, after an hour of quiet or `/memories`): reads only the messages
  since its last read, sees the participants and what the waifus already remember about them,
  and adds, updates, merges or expires memories. Important adds (importance ≥ 4) and edits apply
  at once; the rest queue for the dream. `stageManagerEnabled: false` on a server turns its
  observers off.
- **Dream** (once a night at `memory.dreamHourLocal`, default 05:00 local): one global pass that
  visits waifus round-robin (at most 8 model calls a night, continuing where the last night
  stopped): merges duplicates, rewrites stale phrasing, decays trivia, promotes worthwhile notes.
  `/memories` runs the channel's observer plus a dream for the waifus enabled there.

## Managing memories

- `GET /api/memories` — list/search; filters `waifuId`, `q`, `status`, `limit`, and provenance
  `guildId`, `origin=dm`, `subjectUserId`.
- `POST /api/memories` — add (`pinned` defaults to true for manual entries; optional `guildId`
  provenance and `subjects`).
- `PUT /api/memories/:memoryId` — edit content, kind, pinned, strength, subjects, or archive /
  restore (`status`). Send the memory's own `revision` as `recordRevision`.
- `DELETE /api/memories/:memoryId` — remove (`recordRevision` in the body).
- `POST /api/memories/forget-user {discordUserId, confirm: true, dryRun?}` — forget a person:
  deletes every memory about them (including shared ones), their queued observations, and
  replaces their stored messages with `(removed)`. Conversation summaries keep them until their
  next compaction. The assistant's `forget_user` tool always shows a confirmation card first.

Pin sparingly: pinned records take snapshot slots in every conversation. Canon facts about the
room's people and relationships are good pins; passing jokes are not.
