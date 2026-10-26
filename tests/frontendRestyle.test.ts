// The dashboard restyle: Home is a menu (no status board), the assistant docks beside the page and
// is remembered per viewer, settings forms show human labels from the registry, the Models tab is a
// list of switches over the same catalog, and Activity's model replies show their words.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HOME_MENU, HomeMenu, NeedsYouBar, type HomeNotice } from "../src/frontend/screens/HomeScreen.js";
import { AppShell } from "../src/frontend/App.js";
import { ASSISTANT_OPEN_KEY, readAssistantOpen, shellClassName, writeAssistantOpen } from "../src/frontend/state/assistantDock.js";
import { allowedModelRows, keyLabel, toggleAllowed } from "../src/frontend/screens/settingsForm.js";
import { entrySummary } from "../src/frontend/screens/ActivityScreen.js";
import { LIFE_LIMIT_GROUPS } from "../src/frontend/screens/SettingsScreen.js";
import { requireGroup } from "../src/shared/settings/registry.js";
import { groupKeyInfos } from "../src/shared/settings/introspect.js";
import { keyHelpJson } from "../src/shared/settings/render.js";
import type { CuratedModel } from "../src/frontend/api/types.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    map
  };
}

describe("Home menu", () => {
  it("is one tile per section with a title and one line, and no status board", () => {
    expect(HOME_MENU.map((entry) => entry.title)).toEqual(["Cast", "Life", "Rooms", "Activity", "Settings", "Assistant", "Remote Access"]);
    for (const entry of HOME_MENU) expect(entry.line.length).toBeGreaterThan(10);
    expect(HOME_MENU.find((entry) => entry.id === "assistant")?.target).toBe("assistant");
    expect(HOME_MENU.find((entry) => entry.id === "remote-access")?.target).toEqual({ view: "settings", tab: "remote-access" });

    const html = renderToStaticMarkup(createElement(HomeMenu, { onOpen: () => undefined }));
    for (const entry of HOME_MENU) expect(html).toContain(`>${entry.title}<`);
    for (const gone of ["Who is up", "Recent sends", "AWAKE", "NO BOT", "Needs you"]) expect(html).not.toContain(gone);
    // Four columns at full width: the wide Cast tile plus six fill two rows with no empty cell.
    const units = HOME_MENU.reduce((sum, entry) => sum + (entry.wide ? 2 : 1), 0);
    expect(units % 4).toBe(0);
  });

  it("shows the Needs you bar only when something needs the owner", () => {
    expect(renderToStaticMarkup(createElement(NeedsYouBar, { notices: [] }))).toBe("");
    const notices: HomeNotice[] = [
      { key: "a", title: "Owner notice", chip: "notice", detail: "ella is linked to a Discord bot that has no token" },
      { key: "b", title: "Ella", chip: "model_unmapped", detail: "pick again" }
    ];
    const html = renderToStaticMarkup(createElement(NeedsYouBar, { notices }));
    expect(html).toContain("Needs you · 2");
    expect(html).toContain("ella is linked to a Discord bot that has no token");
    expect(html).toContain("Show all 2");
  });
});

describe("docked assistant", () => {
  it("remembers open or closed per viewer, and survives storage that throws or is missing", () => {
    const storage = memoryStorage();
    expect(readAssistantOpen(storage)).toBe(false);
    writeAssistantOpen(true, storage);
    expect(storage.map.get(ASSISTANT_OPEN_KEY)).toBe("1");
    expect(readAssistantOpen(storage)).toBe(true);
    writeAssistantOpen(false, storage);
    expect(readAssistantOpen(storage)).toBe(false);

    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      }
    };
    expect(readAssistantOpen(throwing)).toBe(false);
    expect(() => writeAssistantOpen(true, throwing)).not.toThrow();
    expect(readAssistantOpen(undefined)).toBe(false);
  });

  it("docks the panel beside the main column instead of over it", () => {
    expect(shellClassName(false)).toBe("shell");
    expect(shellClassName(true)).toBe("shell assistant-docked");
    const panel = createElement("aside", { className: "norma" }, "Norma");
    const open = renderToStaticMarkup(createElement(AppShell, { assistantOpen: true, panel }, createElement("main", null, "page")));
    expect(open).toMatch(/^<div class="shell assistant-docked"><div class="frame"><main>page<\/main><\/div><aside class="norma">Norma<\/aside><\/div>$/);
    const closed = renderToStaticMarkup(createElement(AppShell, { assistantOpen: false, panel }, createElement("main", null, "page")));
    expect(closed).toBe('<div class="shell"><div class="frame"><main>page</main></div></div>');
  });
});

describe("human setting labels", () => {
  const app = requireGroup("app");

  it("every app setting has a short human label, carried by the help JSON next to its key", () => {
    for (const info of groupKeyInfos(app)) {
      expect(info.label, info.path).toBeTruthy();
      expect(info.label!.length, info.path).toBeLessThanOrEqual(40);
      expect(info.label, info.path).not.toMatch(/^[a-z]+[A-Z]/u);
    }
    const turns = groupKeyInfos(app).find((info) => info.path === "life.maxConcurrentTurns")!;
    expect(turns.label).toBe("Turns at once");
    expect(turns.flags).not.toHaveProperty("label");
    const json = keyHelpJson(app, turns);
    expect(json).toMatchObject({ path: "life.maxConcurrentTurns", label: "Turns at once" });
    expect(json.flags).not.toContain("label");
    expect(keyHelpJson(app, groupKeyInfos(app).find((info) => info.path === "life.maxInlineImageBytesPerEpoch")!).label).toBe("Inline image bytes per epoch");
    expect(keyHelpJson(app, groupKeyInfos(app).find((info) => info.path === "models.maxOutputUsdPerMTok")!).label).toBe("Price cap per million output tokens");
  });

  it("forms use the label, and fall back to words for a key without one", () => {
    expect(keyLabel({ path: "life.maxConcurrentTurns", label: "Turns at once" })).toBe("Turns at once");
    expect(keyLabel({ path: "life.maxInlineImageBytesPerEpoch" })).toBe("Max inline image bytes per epoch");
    expect(keyLabel({ path: "enabled" })).toBe("Enabled");
  });

  it("the Life limits tab groups every life key it lists only once", () => {
    const paths = LIFE_LIMIT_GROUPS.flatMap((group) => group.paths);
    expect(new Set(paths).size).toBe(paths.length);
    const known = new Set(groupKeyInfos(app).map((info) => info.path));
    for (const path of paths) expect(known.has(path), path).toBe(true);
  });
});

describe("allowed models list", () => {
  const model = (id: string): CuratedModel =>
    ({ id, providerId: id.split("/")[0], modelId: id.split("/").slice(1).join("/"), displayName: id, providerDisplayName: "P", efforts: [], contributor: false, imageInput: false, credentialsConfigured: false }) as unknown as CuratedModel;

  it("shows the allowed routes (offered or hidden) in order, then the curated ones left off, with switches", () => {
    const rows = allowedModelRows(
      { models: [model("openai/gpt-6-luna")], hidden: [{ id: "openai/gpt-6.1-sol", reason: "over_price_cap" }], available: [model("deepseek/deepseek-flash")] },
      ["openai/gpt-6-luna", "openai/gpt-6.1-sol", "someone/custom"]
    );
    expect(rows.map((row) => [row.id, row.on])).toEqual([
      ["openai/gpt-6-luna", true],
      ["openai/gpt-6.1-sol", true],
      ["deepseek/deepseek-flash", false],
      ["someone/custom", true]
    ]);
    expect(rows[1]!.hiddenReason).toBe("over_price_cap");
  });

  it("a switched-off route stays listed until saved, and switching saves the same models.allowed shape", () => {
    const saved = ["openai/gpt-6-luna", "anthropic/claude-haiku-5-5"];
    const off = toggleAllowed(saved, "openai/gpt-6-luna", false);
    expect(off).toEqual(["anthropic/claude-haiku-5-5"]);
    const rows = allowedModelRows({ models: [model("openai/gpt-6-luna"), model("anthropic/claude-haiku-5-5")], hidden: [], available: [] }, off);
    expect(rows.find((row) => row.id === "openai/gpt-6-luna")?.on).toBe(false);
    expect(toggleAllowed(off, "deepseek/deepseek-flash", true)).toEqual(["anthropic/claude-haiku-5-5", "deepseek/deepseek-flash"]);
    expect(toggleAllowed(saved, "anthropic/claude-haiku-5-5", true)).toEqual(["openai/gpt-6-luna", "anthropic/claude-haiku-5-5"]);
  });
});

describe("Activity model replies", () => {
  it("show the reply's words, a failure's kind, or metadata only", () => {
    expect(entrySummary({ role: "assistant", payload: { content: [{ type: "text", text: "Done." }, { type: "tool_use", name: "get_life" }] } }).line).toBe("Done. → get_life");
    expect(entrySummary({ role: "detector", payload: { content: "ella" } }).line).toBe("ella");
    expect(entrySummary({ role: "assistant", ok: false, payload: { error: { kind: "rate_limit", message: "slow down" } } }).line).toBe("failed: rate_limit · slow down");
    expect(entrySummary({ role: "life", metadataOnly: true, payload: { finishReason: "stop", costUsd: 0.0012 } }).line).toContain("stop: stop");
  });
});
