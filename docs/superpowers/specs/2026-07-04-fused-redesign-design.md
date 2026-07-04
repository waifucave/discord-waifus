# Fused-Cell Dashboard Rebuild — Design (v2, supersedes the Phase-2 restyle)

Approved by user 2026-07-04 via iterated mockup (scratchpad/mockup/index.html, v4).
The previous UI is treated as if it never existed: every screen is rebuilt from scratch in
this language. The data layer (api client, useApi, runtimeStore, llm helpers) is kept.

## The language (locked by mockup approval)

- **Fused grid**: the whole viewport is cells on an ink (#141414) background with 1px seams
  (grid/flex `gap: 1px`). Every element shares its border with its neighbours. No gaps, no
  shadows, no rounding, no gray fills — the only background is white.
- **Typography**: hierarchy by SIZE only (regular weight): hero 44-64px, tile 30-52px,
  title 21px, body 13.5-14px, micro 9-10.5px mono uppercase (grey #9a9a9a). No bold reliance.
- **Pastels — one shade per hue, semantic**: mint #5ef2c1 (cast/replies/confirm), sky
  #8fd8f8 (rooms/discord/input focus), lavender #cabfff (direction/decisions), butter
  #ffe97a (memory/warnings), peach #ffc9a3 (activity/logs), pink #ffb8dc (Norma).
  Settings inverts to ink on hover. Every character owns a hue (assigned cyclically).
- **Hover snaps** — instant background flood of the element's hue, zero transitions.
- **Asymmetric mosaic** — cells vary in size; big hero tiles, wide feature cells, small
  utility cells. Nothing must look like a uniform table.
- **Navigation = home screen**: Home is a launcher of big section tiles with live meta
  inside; entering a section replaces the screen and shows a **← back cell** (96px) in the
  header row. No sidebar. Hash routes stay (`#/cast` etc.), legacy routes redirect.

## Screens

- **Home (launcher)**: brand cell · Live hero cell (status + real stats: bots, servers,
  waifus, memories) · Assistant tile (pink, opens Norma) · section tiles (Cast hero 2-row,
  Rooms, Direction, Memory, Activity, Settings) each with live meta · live feed column
  (recent orchestrator decisions/outcomes from /api/orchestrator/history + stage-manager
  history, kind-chips mint/lavender/butter) · quiet explainer cell · status footer strip
  (version, providers ok, discord, queues).
- **Cast**: header [←][Cast · counts][+ New character]; mosaic of character cells (first
  cell double-width, per-character hue hover, model/memories/bot meta, status micro, Nox-style
  "needs setup" butter chip) + a big `+` cell. Click → **Character editor screen** (not a
  modal): header [←][Name][Save mint cell]; fused form cells for identity (name/display),
  persona textarea, model picker + params (restyled ModelParamsForm), context window,
  availability, bot link, prompt-layout editor, digest info, danger cell (delete, hover red
  #ffb3b3 — the one non-pastel exception, from mockup v1 feedback allowance).
- **Rooms**: guild cells (mosaic), each opening a guild screen with channel rows: per-channel
  waifu enable chips (each chip the character's hue when enabled).
- **Direction**: header tabs as fused cells [Orchestrator][Stage manager][Reviewer][Assistant]
  (lavender family hover); each tab = rebuilt config form in fused cells.
- **Memory**: search/filter row cells + memory record cells (kind chip colors; pinned = butter
  edge), inline edit/delete.
- **Activity**: tabs [Logs][Queries][Replies]; log lines as thin fused rows (mono), queries/
  replies as expandable cells.
- **Settings**: tabs [Providers][App]; provider rows with ADD KEY cells (hover mint), app
  settings cells, "Run setup wizard" cell.
- **Norma (assistant panel)**: right column 380px fused; header [Norma + model micro][+][✕]
  (centered glyphs); transcript — user msgs right-aligned with grey YOU micro-label, Norma
  msgs plain left (no label), tool chips pink `name` + grey status; thin 68px input row;
  SEND white, pink hover. Backend: assistant system prompt names her Norma.
- **Onboarding wizard**: reskinned to the language (ink rail with mono step indices, white
  main, pastel accents per step).

## Implementation notes

- New `src/frontend/styles/system.css` replaces tokens.css+app.css entirely. Old view files
  are deleted as their replacements land. Reused structural components (ModelParamsForm,
  PromptLayoutEditor, DiscordBotGuide, Toggle, Modal where still needed) keep their class
  names; system.css styles those classes in the new language (flat, 1px, sky focus).
- Router gains `home` as default; sections: cast, rooms, direction, memory, activity,
  settings (+ per-section `?tab=`/`?id=` params). Legacy aliases redirect.
- Live feed derives from existing endpoints only (orchestrator history, stage-manager
  history, /api/status); no new backend endpoints required except none.
- Backend change: `assistantSystemPrompt` introduces "You are Norma, the dashboard
  assistant…" (name only; behavior unchanged).
- Release as 1.5.181 after full QA; deployed to Beta.

## Out of scope

Dark mode; mobile; conversation persistence; onboarding step content changes.
