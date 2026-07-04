# Fused-Cell Dashboard Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild every dashboard screen from scratch in the approved fused-cell language (spec: `docs/superpowers/specs/2026-07-04-fused-redesign-design.md`; visual source of truth: the committed mockup `2026-07-04-fused-redesign-mockup.html`).

**Architecture:** New `system.css` (ink background + white cells + 1px seams + six pastels + size-based type) replaces the old stylesheets. New screen components replace the old views one task at a time behind a home-launcher router (`home` + section screens + back cells); old views are deleted as replacements land. Data layer (api client, useApi, llm helpers, ModelParamsForm/PromptLayoutEditor logic) is reused; reused components are restyled purely via their existing class names in system.css. Release only at the end (1.5.181) — intermediate commits may carry placeholder screens.

**Tech Stack:** React 19, Vite, hand-rolled CSS (no framework), lucide only where glyphs are needed.

## Global Constraints

- The mockup file is normative for palette, seams, type scale, hover behavior (snap, no transition), and the Home/Cast/Norma layouts. When in doubt, copy its CSS values.
- One shade per hue. Only backgrounds: white cells + pastel floods + ink (settings hover / brand / seams). Danger hover: #ffb3b3.
- Hierarchy by size, never weight (font-weight 400 everywhere; 500 max for tiny micro labels if unreadable).
- No transitions/animations anywhere (except none — hover snaps).
- Every commit: frontend typecheck + build green.

---

### Task 1: system.css + shell + router + Home launcher
- `src/frontend/styles/system.css` transposed from the mockup (frame/cell/hues/type/tiles/feed/footer + generic form layer styling the existing classes: `.field`, `.input`, `.select`, `.textarea` → flat 1px ink border, sky focus fill; `.range-field`, `.checkbox-chip`, `.prompt-lane` family, `.model-params-*` → fused equivalents).
- `main.tsx` imports system.css only (tokens.css/app.css deleted in Task 7 cleanup).
- Router: `home | cast | rooms | direction | memory | activity | settings` (+ `?tab=`, `?id=`), default home, legacy aliases (incl. old `app-settings` → settings).
- `App.tsx`: renders `<div class="frame">` + current screen; no sidebar/topbar. Home screen component with: brand cell, Live hero (from /api/status), Assistant tile (opens Norma), six section tiles with live meta (waifus count, servers count, memory count via existing endpoints), feed column (orchestrator history decisions + outcomes → kind chips), quiet cell, footer strip. Placeholder screen component (`<ComingCell/>` with back) for sections not yet rebuilt.
- Verify: build + headless screenshots home.

### Task 2: Cast screen + character editor screen
- Cast mosaic per mockup (first character double-width, per-character hue via cyclic assignment, status micro from availability/enabled, "needs setup" butter chip when model/bot missing, `+` cell → create flow).
- Character editor as a screen (`#/cast?id=riko`): header [←][name][Save mint]; fused form cells: identity, persona, model picker (llm helpers), ModelParamsForm, context window, availability, bot link (DiscordBotGuide reachable), prompt layout (PromptLayoutEditor), digest info + regenerate cell, delete cell (danger hover) with confirm.
- Create flow: `+` opens the editor screen in create mode (id field editable).
- Delete old WaifusView.

### Task 3: Direction screen (4 tabs)
- Header [←][Direction][tab cells ×4]. Rebuild orchestrator/stage-manager/reviewer/assistant config forms in fused cells (model picker + params + prompt + agent-specific fields; orchestrator history feed cell). Delete old OrchestratorView/StageManagerView/ReviewerView/AssistantView/DirectionView.

### Task 4: Rooms + Memory screens
- Rooms: guild mosaic → guild screen with channel rows; per-channel character enable chips (character hue when enabled), context window field. Delete ServersView.
- Memory: filter row cells (waifu/guild/kind/search) + record cells with kind chips, pin toggle (butter), edit/delete inline, + new memory cell. Delete MemoriesView.

### Task 5: Activity + Settings + onboarding reskin
- Activity tabs: Logs (thin mono rows, level chips), Queries/Replies (expandable cells, role filter). Delete LogsView/QueriesView/RepliesView/ActivityView.
- Settings tabs: Providers (rows + ADD KEY cells, models popover→cell list), App (existing settings + Run setup wizard cell). Delete ProvidersView/SettingsView/SettingsSectionView.
- Onboarding: reskin wizard to language (ink rail, mono indices, pastel per step, fused inputs).
- Home setup card equivalents: launcher tiles show butter "needs setup" chips when their area is unconfigured (replaces the old checklist card).

### Task 6: Norma panel + backend name
- Rebuild AssistantPanel in the language per mockup v4 (YOU label only, no label on Norma messages, header Norma + model micro, centered +/✕, 68px input, SEND white/pink hover, pink tool chips). Launcher tile keeps "Assistant".
- Backend: `assistantSystemPrompt` → "You are Norma, the assistant for the Discord Waifus dashboard…" (name only; tests updated if any assert the old opening).

### Task 7: QA + release
- Delete tokens.css/app.css and any orphaned components; typecheck + full tests + build.
- Headless screenshots of every screen incl. tabs, editor, Norma, onboarding (`?screen=`-style helpers not needed — real hashes work). Fix visual defects.
- Release 1.5.181 ("feat: fused-cell dashboard — full from-scratch UI rebuild"), deploy Beta pinned, verify SPA + Norma live, update memory.

## Self-Review
- Spec coverage: every screen + Norma + onboarding + backend name + feed/meta sourcing → T1-T6; QA/release → T7. ✓
- Mockup-as-source avoids placeholder-code risk for CSS; forms reuse named components. ✓
- Deletions tracked per task so the old UI truly ceases to exist. ✓
