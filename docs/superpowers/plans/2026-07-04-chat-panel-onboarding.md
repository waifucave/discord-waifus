# Chat Panel + Onboarding (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The corner assistant chat (wired to the Phase-1 API) and the first-run onboarding wizard, completing the approved dashboard redesign.

**Architecture:** Two self-contained frontend features on the existing data layer. Chat: an `AssistantLauncher` (fixed bottom-right square button) + `AssistantPanel` (fixed right-side panel) mounted in the App shell; conversation id kept in `sessionStorage`; events streamed from `GET /api/assistant/conversations/:id/stream` via `EventSource`; sends via `POST .../messages`. Onboarding: a full-screen `OnboardingWizard` shown when no provider is configured (dismissible, re-runnable from Settings → App), stepping through provider key → models → waifu models → Discord bots → enable a channel, all via the existing api client.

**Tech Stack:** React 19, EventSource SSE, existing api client + llm registry helpers.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-04-dashboard-redesign-design.md` (Phase 3 section).
- White/sharp system: zero radius, hairline borders, ink primaries (reuse existing classes).
- The launcher is present on every view. With no resolvable model, the panel opens with the 503 reason and a link to Direction → Assistant (never a dead button).
- Fresh data roots auto-seed prebuilt waifus, so the wizard's waifu step assigns models to model-less waifus rather than assuming none exist.
- Frontend-only phase (plus one optional backend nicety: none required).

---

### Task 1: Assistant chat — API client + panel components

**Files:**
- Modify: `src/frontend/api/client.ts` (assistant chat methods)
- Create: `src/frontend/components/assistant/AssistantLauncher.tsx`, `src/frontend/components/assistant/AssistantPanel.tsx`, `src/frontend/state/assistantChat.ts`
- Modify: `src/frontend/App.tsx` (mount launcher+panel), `src/frontend/styles/app.css` (panel styles)

**Client methods:**
```ts
createAssistantConversation: () => request<{ conversationId: string }>("POST", "/api/assistant/conversations", {}),
assistantConversation: (id: string, signal?: AbortSignal) =>
  request<{ id: string; busy: boolean; messages: AssistantStoredMessage[] }>("GET", `/api/assistant/conversations/${id}`, { signal }),
sendAssistantMessage: (id: string, content: string) =>
  request<{ reply: string }>("POST", `/api/assistant/conversations/${id}/messages`, { body: { content } }),
```
`AssistantStoredMessage` mirrors the backend StoredMessage union in `api/types.ts`.

**`assistantChat.ts` hook:** `useAssistantChat()` returns `{ messages, busy, error, send, reset }`. Holds conversationId in `sessionStorage` (`assistant-conversation`); lazily creates on first send/open; opens an `EventSource` on the stream URL and folds events into local state (`tool_call`/`tool_result` rows, `text` final replies, `error`); `send()` posts optimistically (user message appended immediately); `reset()` clears storage + state and creates a fresh conversation. On a 404 for a stale stored id (server restarted), transparently create a new conversation.

**Panel UI:** header ("Assistant" + model line when known + new-conversation + close buttons), scrollable transcript (user bubbles right-aligned outline, assistant text plain, tool rows as mono micro-lines `▸ list_waifus — ok` expandable to the result), busy indicator while a turn runs, input (textarea, Enter sends, Shift+Enter newline). When send fails with 503, render the error text + "Configure the assistant model" link → `direction?tab=assistant`. Launcher: fixed 44px square ink button bottom-right with a chat glyph; toggles the panel; hidden while the onboarding wizard is open.

- [ ] Build + local run: open panel, see the no-model 503 path render (test root has no keys).
- [ ] Commit `feat: corner assistant chat panel`.

---

### Task 2: Onboarding wizard

**Files:**
- Create: `src/frontend/components/onboarding/OnboardingWizard.tsx` (+ step subcomponents in the same file if small)
- Modify: `src/frontend/App.tsx` (gate + mount), `src/frontend/views/SettingsView.tsx` (re-run button), `src/frontend/styles/app.css`

**Gate:** show when `providers` are loaded and none configured and `localStorage["onboarding-dismissed"] !== "1"`. Dismiss (X / "skip for now") sets the flag; the Settings → App "Run setup wizard" button clears it.

**Steps (state machine, progress rail on the left):**
1. **Welcome** — what the app is (three sentences), [Start] / [Skip].
2. **Provider key** — provider select (from `/api/providers` registry list) + key input → `api.putProviderCredentials`; success advances; link to provider docs.
3. **Models** — orchestrator model picker (registry, filtered to configured providers; reuse `modelParams/logic` helpers) → save orchestrator config; plus "default waifu model" picker (stored in component state for step 4).
4. **Cast** — list waifus without models; [Apply default model to all] does read-merge-PUTs; inline "add another waifu" (name + persona) optional.
5. **Discord bots** — condensed guide (reuse `DiscordBotGuide`) + orchestrator token/appId inputs → save discord-bots (read-merge-PUT), then `api.runtimeReload()`; shows live connect status pill.
6. **Channel** — if servers exist, per-channel waifu toggles (reuse the Rooms PATCH call shape); else guidance that the server list appears once the bot joins a guild; [Finish] regardless.
Finish sets the dismissed flag and closes.

Every step is skippable ("later" advances without saving). The wizard renders full-screen (`position: fixed; inset: 0; background: var(--bg-app)`) with the same sharp styling.

- [ ] Build + local run on a fresh temp root: wizard appears, provider step saves a fake key, dismiss works, Settings re-run works.
- [ ] Commit `feat: first-run onboarding wizard`.

---

### Task 3: Release + live verify

- [ ] `npm run typecheck` && `npm run test` && `npm run build` clean.
- [ ] Release `1.5.180`, deploy Beta pinned (retry on ETARGET), restart.
- [ ] Live verify on Beta: dashboard serves; assistant panel answers a real question end-to-end (Beta has keys/models); onboarding does NOT appear (providers configured).
- [ ] Update memory; report with screenshots.

## Self-Review

- Spec coverage: launcher+panel with SSE tool events (T1), model-missing path → assistant config link (T1), onboarding gated to new users, re-runnable, all five setup areas (T2), release+verify (T3). ✓
- Placeholders: none — component responsibilities, state shapes, and endpoints named exactly. ✓
- Type consistency: `AssistantStoredMessage` mirrors backend `StoredMessage`; hook return shape used by panel. ✓
