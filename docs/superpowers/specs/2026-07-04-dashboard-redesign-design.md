# Dashboard Redesign + Embedded Assistant — Design

Approved by user 2026-07-04 (visual: white/sharp; agent: direct writes; API-completeness goal).

## Goals

1. A fresh, super-user-friendly dashboard UI replacing the current dark ops look.
2. An embedded assistant agent, reachable from a corner chat, that can read and **directly
   change** app state through tools backed by the app's own REST API.
3. API surface complete enough that any external agent (e.g. Claude Code hitting
   `127.0.0.1:3888`) can operate the app exactly like the embedded assistant.
4. First-run onboarding wizard for new users; the assistant (with a bundled docs KB) is the
   help path for existing users.
5. Seamless gateway integration throughout: model pickers from the live registry, capability-
   aware param forms, write-side `gateway.validate()` errors surfaced inline.

## Locked decisions

- **Visual style:** light-first, white. Sharp corners — `border-radius: 0` everywhere. Flat
  surfaces, crisp 1px borders, generous whitespace, strong typographic hierarchy. No glass,
  no blur, no soft shadows. Single restrained accent color plus per-waifu accent chips.
  Light-only (no theme toggle) in v1.
- **Agent powers:** direct writes. Tools execute immediately against the REST API; the chat
  transcript shows each tool call and its result. No proposal/approval layer. Provider API
  keys remain write-only (agent sees redacted status, can set a key the user pastes in chat).
- **Agent identity:** new `assistant` agent config (`user/assistant/config.json`,
  `AgentConfigSchema` shape): optional own model/params, falls back to the orchestrator's
  model when unset. Neutral helpful ops voice.
- **Navigation:** 13 views consolidate to 7 sections: Home, Cast (waifus), Rooms (servers),
  Direction (orchestrator · stage-manager · reviewer · assistant), Memory, Activity
  (logs · queries · replies), Settings (providers · Discord bots · app).
- **Delivery:** three phased plans, each independently releasable:
  P1 assistant backbone (backend) → P2 UI redesign → P3 chat UI + onboarding.

## Phase 1 — Assistant backbone (backend)

**Assistant agent config.** `user/assistant/config.json` via `readAgentConfig`/agent-config
plumbing; API `GET/PUT /api/assistant/config` (same validation path as the other agents:
zod body, `gateway.validate()`, `expectedRevision`). Model resolution: assistant's own
`(providerId, modelId)` if set, else orchestrator's.

**Chat API.**
- `POST /api/assistant/conversations` → `{ conversationId }` (in-memory store, LRU/TTL;
  not persisted across restarts in v1).
- `POST /api/assistant/conversations/:id/messages` `{ content }` → runs one agent turn,
  returns the final assistant message; intermediate events stream over SSE.
- `GET /api/assistant/conversations/:id/stream` → SSE: `turn_started`, `text_delta` (when the
  model streams; otherwise `text`), `tool_call` (name + args), `tool_result` (summary),
  `turn_completed`, `error`.
- `GET /api/assistant/conversations/:id` → transcript (for panel re-open).

**Agent loop.** New pipeline capability `generateAssistantTurn` on the gateway pipeline:
multi-turn messages + tool definitions, loop while the model emits tool calls (cap ~12
calls/turn), execute tools, append results, repeat until text-only reply. Params pre-conform
via existing `preconformRequest` (forced-tool rules etc. apply for free).

**Tool registry — self-REST dispatch.** Tools execute by dispatching in-process to the app's
own Fastify handlers (`app.inject`), so every existing guard (zod schemas, gateway
validation 400s, revision 412s) applies unchanged. Write tools do read-modify-write:
GET current → merge → PUT with `expectedRevision`; on 412 retry once with fresh read.

Tool set (v1):
| Tool | Maps to |
|---|---|
| `get_runtime_status` | GET /api/runtime + /api/status |
| `list_providers` / `set_provider_key` / `clear_provider_key` | /api/providers* (keys write-only) |
| `list_models` | gateway registry via /api/llm (id, provider, capabilities) |
| `list_waifus` / `get_waifu` / `create_waifu` / `update_waifu` / `delete_waifu` | /api/waifus* |
| `regenerate_waifu_digest` | POST /api/waifus/:id/digest |
| `list_servers` / `update_channel` | /api/servers* (enable/disable waifus per channel, settings) |
| `list_discord_bots` / `update_discord_bots` | /api/discord-bots |
| `get_agent_config` / `update_agent_config` | orchestrator, stage-manager, reviewer, assistant configs |
| `search_memories` / `add_memory` / `update_memory` / `delete_memory` | /api/memories* |
| `trigger_orchestrator` / `trigger_stage_manager` | /api/runtime/trigger/* |
| `runtime_pause` / `runtime_resume` / `runtime_reload` | /api/runtime/* |
| `read_logs` | new GET /api/logs (recent ring buffer) |
| `docs_search` / `docs_read` | bundled KB (below) |

**Docs KB.** `docs/assistant-kb/*.md` shipped in the npm package: one file per topic
(providers & keys, waifu config & prompt layout, orchestrator & directives, memory system,
Discord bot setup, gateway params & capabilities, troubleshooting). Served at
`GET /api/docs` (index) and `GET /api/docs/:slug` — used by the assistant tools, the
dashboard help, and any external agent.

**API expansion for external agents.** Gaps closed so the full app is REST-operable:
`GET /api/logs`, the `/api/assistant/*` family, `GET /api/docs*`. Everything else already
exists (SPA parity). `docs/assistant-kb/api.md` documents the REST surface so Claude Code
can drive it directly.

**System prompt.** App overview + current-state snapshot (counts, runtime status) + tool
guidance + care rules (never echo secrets; confirm in-chat before deleting a waifu or
changing bot tokens — conversational confirmation, not a UI gate).

## Phase 2 — UI redesign

**Design system.** Rewritten `tokens.css` + `app.css`: white background, near-black text,
1px hairline borders (`#e4e4e4`-family), zero radius, flat buttons (solid black primary,
outlined secondary), uppercase section labels, generous spacing scale, larger type scale,
visible 2px focus outlines, minimal motion (fast fades only). Per-waifu accent used in
avatars/chips/headers. Component kit: Panel, Table, Field, Button, Tabs, StatusDot, Chip,
EmptyState, Modal (all sharp).

**Navigation & views.** Sidebar with the 7 sections; each view rebuilt on the new kit while
keeping the existing data layer (`api/client.ts`, `useApi`, `runtimeStore`, manual type
mirror). Direction section hosts the four agent configs as tabs (orchestrator, stage-manager,
reviewer, assistant). Activity merges logs/queries/replies as tabs. Settings merges
providers, Discord bots, app settings. Model pickers + param forms stay gateway-driven
(restyled `ModelParamsForm`).

## Phase 3 — Chat UI + onboarding

**Chat panel.** Floating square launcher bottom-right (assistant glyph; subtle unread dot).
Click → 400px right-side panel: transcript, tool-activity rows (name + one-line result,
expandable), streaming text, input with Enter-to-send, "new conversation" action, and the
assistant's model shown in the header (click → assistant config). Available on every view
once a provider + model resolve; otherwise the launcher deep-links to onboarding/settings.

**Onboarding wizard.** Full-screen (light, sharp) shown when zero providers are configured.
Steps: 1 welcome → 2 add provider key (validated live) → 3 pick models (orchestrator +
default waifu model; registry suggestions filtered to configured providers) → 4 create first
waifu (prebuilt seed templates or custom name+persona) → 5 Discord bots (restyled guide,
token entry) → 6 enable a channel → done. Skippable per-step and dismissible; re-runnable
from Settings. Old SetupView folds into a Home health card and is removed.

## Testing & verification

- Vitest: assistant config API, conversation lifecycle, tool registry dispatch (self-REST
  against a real Fastify instance + temp storage root), read-modify-write revision retry,
  docs endpoints, onboarding gating logic.
- Live: `waifus dev` locally + browser (screenshots per view); assistant end-to-end against
  a real model on Beta after each phase's release.
- Each phase ships as its own app release, deployed to Beta.

## Out of scope (v1)

Conversation persistence across restarts; assistant persona theming; dark mode; proposal/
approval UI; mobile layout (desktop-first, but nothing intentionally broken on narrow
viewports).
