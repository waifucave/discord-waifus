# Memory

How waifus remember: the unified memory store, retrieval, pinning, and dreams.

## The store

One unified store (`user/memories.json`) of MemoryRecords shared by the whole cast. Each record
has: `content`, `kind` (fact / preference / event / commitment / context / note), scope
(guild + optional waifu), `strength` (decays over time unless reinforced), `pinned` (never
decays, always eligible), entity tags, and timestamps. Sources: stage-manager observations,
waifu in-chat `add_memory` notes (short-lived unless the dream pass promotes them), the nightly
dream consolidation, and manual entries.

## Retrieval

Per waifu turn, a scored top-12 selection (recency, strength, entity overlap with the live
conversation, waifu affinity) plus all pinned records is injected into her prompt as
`relevant_memories`. Nothing is ever injected wholesale — a big store stays cheap.

## Dreams

Nightly per-guild pass (~05:00 local, jittered): merges duplicates, rewrites stale phrasing,
decays trivia, promotes worthwhile notes into durable records. Watch results with the
`/memories` Discord command or `GET /api/memories`.

## Managing memories

- `GET /api/memories` (full store — filter client-side) — list/search.
- `POST /api/memories` — add (set `pinned: true` for canon facts you never want to decay).
- `PUT /api/memories/:memoryId` — edit content, kind, pinned, strength.
- `DELETE /api/memories/:memoryId` — remove.

Pin sparingly: pinned records occupy retrieval slots on every turn. Canon facts about the
room's people and relationships are good pins; passing jokes are not.
