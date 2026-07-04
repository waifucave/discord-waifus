# UI Redesign (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dark ops UI with the approved white/sharp design system and consolidate 13 views into 7 sections (Home, Cast, Rooms, Direction, Memory, Activity, Settings), including a new Assistant config tab.

**Architecture:** Strategy A — the views share a coherent CSS class vocabulary (~70 classes in `app.css`), so the redesign rewrites `tokens.css` + `app.css` under the SAME class names (views keep working), then restructures the IA: `nav.ts`/`router.ts`/`App.tsx` move to 7 sections, with new thin wrapper views hosting the old views as tabs (Direction = orchestrator/stage-manager/reviewer/assistant; Activity = logs/queries/replies; Settings = providers/discord-bots/app). SetupView's checklist folds into a Home health card. Data layer untouched.

**Tech Stack:** React 19, Vite, hand-rolled CSS custom-property system, lucide-react icons.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-04-dashboard-redesign-design.md` (Phase 2 section).
- **White/light only. `border-radius: 0` everywhere — no exceptions.** No blur, no glass, no soft multi-layer shadows. 1px hairline borders. Single accent + per-waifu accent chips.
- Old hash routes must not break: `#/orchestrator` etc. redirect into the right section+tab.
- Frontend types mirror `src/shared/schemas/domain.ts` manually — no value imports from the gateway package client-side.
- Verification is visual: local run + browser screenshots per section (no view unit tests exist).

---

### Task 1: Design system — tokens + component restyle

**Files:**
- Rewrite: `src/frontend/styles/tokens.css`
- Rewrite: `src/frontend/styles/app.css` (same class names, new rules)

**Step 1 — tokens.css (complete):**

```css
:root {
  color-scheme: light;

  /* Surfaces — paper white, flat */
  --bg-app: #ffffff;
  --bg-sidebar: #fafafa;
  --bg-panel: #ffffff;
  --bg-panel-hover: #f6f6f6;
  --bg-input: #ffffff;
  --bg-elevated: #fafafa;

  /* Borders — crisp hairlines */
  --border-subtle: #ececec;
  --border-default: #dedede;
  --border-strong: #111111;
  --border-focus: #111111;

  /* Text — near-black hierarchy */
  --text-primary: #111111;
  --text-secondary: #555555;
  --text-muted: #8a8a8a;
  --text-disabled: #bdbdbd;

  /* Accent — one signal color; primary actions are solid black */
  --accent: #2f56e0;
  --accent-strong: #2445c0;
  --accent-text: #ffffff;

  /* Status */
  --ok: #1a7f4b;
  --ok-bg: #e9f6ef;
  --warn: #9a6700;
  --warn-bg: #fff4d6;
  --err: #c62f2f;
  --err-bg: #fdecec;
  --info: #2f56e0;
  --info-bg: #edf1fd;
  --neutral: #6b6b6b;
  --neutral-bg: #f1f1f1;

  /* Sizing — SHARP: radius is zero by design, everywhere */
  --sidebar-w: 232px;
  --topbar-h: 52px;
  --radius-sm: 0;
  --radius-md: 0;
  --radius-lg: 0;

  /* Spacing scale */
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px;
  --sp-5: 20px; --sp-6: 24px; --sp-8: 32px; --sp-10: 40px;

  /* Typography */
  --font-sans: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: "SF Mono", "JetBrains Mono", Menlo, Monaco, Consolas, monospace;
  --fs-xs: 11px; --fs-sm: 12.5px; --fs-md: 14px; --fs-lg: 16px; --fs-xl: 20px; --fs-2xl: 28px;

  /* Flat depth: at most one hard hairline shadow */
  --shadow-hard: 0 1px 0 rgba(0, 0, 0, 0.06);
}
```

**Step 2 — app.css restyle directives** (rewrite each group under its existing class names):
- Shell/nav: white sidebar with 1px right border; nav items square, uppercase 11px letter-spaced section labels; active item = solid black left bar (3px) + black text; hover = `--bg-panel-hover`.
- Panels: white, 1px `--border-default`, no shadow (`--shadow-hard` on sticky headers only); `.panel-title` 16px/600; `.panel-subtitle` secondary.
- Buttons: `.btn` = outlined black 1px, square, uppercase 12px, letter-spacing 0.04em; `.btn.primary` = solid black, white text; `.btn.danger` = outlined `--err`, hover fills; focus-visible = 2px solid offset outline.
- Inputs/selects/textareas: square, 1px border, black 2px focus border (no glow); `.field` label 12px/600 uppercase muted.
- Tables `.data-table`: hairline row separators only, no zebra; header row uppercase 11px muted with bottom 1px black border.
- Pills `.pill`: square chips, 1px border, status colors from tokens; no radius.
- Modals: square, hard 1px black border, backdrop `rgba(0,0,0,0.35)` (no blur).
- Prompt-layout editor lanes/cards, model cards, log lines, kv rows, toggles, skeletons: same treatment — flat, hairline, square.
- Motion: only `background-color 120ms` / `border-color 120ms`; remove any transform/opacity animations.

- [ ] **Step 3 — build + local visual check:** `npm run typecheck` (frontend config) + `npm run build` succeed; run app locally with a temp data root, screenshot Dashboard/Waifus/Orchestrator, verify: white, sharp, readable.
- [ ] **Step 4 — commit** `feat: white sharp design system (tokens + component restyle)`.

---

### Task 2: 7-section IA — nav, router aliases, wrapper views

**Files:**
- Modify: `src/frontend/nav.ts`, `src/frontend/state/router.ts`, `src/frontend/App.tsx`
- Create: `src/frontend/components/Tabs.tsx`, `src/frontend/views/DirectionView.tsx`, `src/frontend/views/ActivityView.tsx`, `src/frontend/views/SettingsSectionView.tsx`, `src/frontend/views/HomeView.tsx`
- Delete: `src/frontend/views/SetupView.tsx` (checklist folds into HomeView health card)

**New nav (complete):**

```ts
export type ViewId = "home" | "cast" | "rooms" | "direction" | "memory" | "activity" | "app-settings";

export const NAV: NavEntry[] = [
  { id: "home", label: "Home", icon: Activity },
  { id: "cast", label: "Cast", icon: Sparkles },
  { id: "rooms", label: "Rooms", icon: Server },
  { id: "direction", label: "Direction", icon: Compass },
  { id: "memory", label: "Memory", icon: Brain },
  { id: "activity", label: "Activity", icon: ScrollText },
  { id: "app-settings", label: "Settings", icon: Cog }
];
```

(no groups — 7 flat entries). Router: `VALID` = new ids; legacy hash aliases map old→new (`dashboard→home`, `setup→home`, `waifus→cast`, `servers→rooms`, `orchestrator|stage-manager|reviewer→direction?tab=...`, `memories→memory`, `logs|queries|replies→activity?tab=...`, `providers|settings→app-settings?tab=...`); the router keeps a `?tab=` query in the hash and exposes it (`useRoute` returns `[view, tab, navigate]`).

**Tabs component:** square underline tabs (active = 2px black bottom border), driven by the hash `?tab=`.

**Wrappers:** `DirectionView` renders Tabs [Orchestrator, Stage manager, Reviewer, Assistant] hosting the existing views unchanged; `ActivityView` = [Logs, Queries, Replies]; `SettingsSectionView` = [Providers, Discord bots, App] (Discord-bots UI extracted from the old SettingsView if it lives there — verify and move; App tab keeps the remaining app settings). `HomeView` = old DashboardView content + a "Setup" health card replicating SetupView's checks (provider configured, orchestrator model, ≥1 waifu, bots connected, ≥1 enabled channel) with links into sections.

- [ ] Build + screenshots of all 7 sections; legacy `#/orchestrator` redirects correctly.
- [ ] Commit `feat: 7-section navigation with tabbed Direction/Activity/Settings`.

---

### Task 3: Assistant config tab

**Files:**
- Create: `src/frontend/views/AssistantView.tsx` (fourth Direction tab)
- Modify: `src/frontend/api/client.ts` (+`assistantConfig` get/put), `src/frontend/api/types.ts` if anything missing

Reuse the OrchestratorView form pattern: enabled toggle, provider/model picker (gateway registry via `api/llm.ts`), `ModelParamsForm`, contextWindow, save with revision. Copy states: "model unset — using the orchestrator's model" hint when `modelId` empty.

- [ ] Screenshot + save/load round-trip against a local backend.
- [ ] Commit `feat: assistant config tab in Direction`.

---

### Task 4: Visual QA pass

Run backend+frontend locally with seeded data (2 waifus, 1 fake server entry, some memories). Screenshot every section and every tab; fix visual defects found (spacing, contrast, overflow, focus states, empty states). Iterate until clean.

- [ ] Commit `fix: visual QA pass over the redesigned views`.

---

### Task 5: Release + deploy

- [ ] `npm run typecheck` && `npm run test` && `npm run build` all clean.
- [ ] Release `1.5.179` (`feat: white sharp dashboard redesign — 7-section navigation + assistant tab`), deploy Beta pinned (`--prefer-online`, retry on ETARGET), restart, load the live dashboard headers via curl to confirm the SPA serves.
- [ ] Update memory.

## Self-Review

- Spec coverage: design system (T1), 7 sections + tab wrappers + Setup fold-in (T2), assistant tab (T3), gateway-driven pickers unchanged (reused components), QA (T4), release (T5). Phase 3 items (chat panel, onboarding) intentionally absent. ✓
- Placeholder scan: tokens complete; app.css given as per-group directives with concrete values (full file impractical inline); wrapper/router shapes specified. ✓
- Type consistency: ViewId union matches router VALID and App.tsx switch; `useRoute` tuple change is applied with all call sites. ✓
