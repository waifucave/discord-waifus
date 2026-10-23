import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATION_STEPS, runMigrations } from "../src/backend/migrations.js";
import {
  dropPromptLayoutFromWaifus,
  migrateWaifuDropPromptLayout
} from "../src/backend/migrationSteps/waifuDropPromptLayout.js";
import { WaifuConfigSchema } from "../src/shared/schemas/domain.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => removeTempRoot(root)));
  roots.length = 0;
});

async function freshRoot(): Promise<string> {
  const root = await makeTempRoot();
  roots.push(root);
  return root;
}

async function writeWaifu(root: string, id: string, extra: Record<string, unknown>): Promise<void> {
  const filePath = path.join(root, "user", "waifus", id, "waifu.json");
  await mkdir(path.dirname(filePath), { recursive: true });
  const body = {
    schemaVersion: 2,
    revision: 3,
    updatedAt: "2026-10-01T00:00:00.000Z",
    id,
    name: id,
    displayName: id,
    persona: "kind",
    ...extra
  };
  await writeFile(filePath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

async function readWaifu(root: string, id: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(root, "user", "waifus", id, "waifu.json"), "utf8"));
}

type Layout = { top: unknown[]; mid: unknown[]; trailing: unknown[] };

// The last stored default layout (W2), inline: the schema and its default were removed (spec 8.6).
function defaultWaifuPromptLayout(): Layout {
  const block = (blockId: string) => ({ kind: "block", blockId, enabled: true });
  return {
    top: ["identity", "persona", "schedule", "ioFormat", "tools", "outputContract"].map(block),
    mid: ["roomInfo", "relevantMemories"].map(block),
    trailing: ["anchor", "currentlyDoing", "directorNote"].map(block)
  };
}

function layoutWith(mutate: (layout: Layout) => void): Layout {
  const layout = JSON.parse(JSON.stringify(defaultWaifuPromptLayout())) as Layout;
  mutate(layout);
  return layout;
}

function disableBlock(layout: Layout, blockId: string): void {
  for (const slot of [layout.top, layout.mid, layout.trailing]) {
    for (const node of slot as Array<{ kind: string; blockId?: string; enabled?: boolean }>) {
      if (node.kind === "block" && node.blockId === blockId) node.enabled = false;
    }
  }
}

describe("waifu-drop-prompt-layout-v1", () => {
  it("is registered live (the waifu harness no longer reads layouts)", () => {
    const step = MIGRATION_STEPS.find((candidate) => candidate.id === "waifu-drop-prompt-layout-v1")!;
    expect(step.pending).toBeUndefined();
    expect(step.run).toBe(migrateWaifuDropPromptLayout);
  });

  it("maps a disabled top-level schedule block to scheduleInPrompt:false and drops the layout", async () => {
    const root = await freshRoot();
    await writeWaifu(root, "yuki", { promptLayout: layoutWith((layout) => disableBlock(layout, "schedule")) });

    expect(await dropPromptLayoutFromWaifus(root)).toBe(1);

    const saved = await readWaifu(root, "yuki");
    expect(saved).not.toHaveProperty("promptLayout");
    expect(saved.scheduleInPrompt).toBe(false);
    expect(saved).toMatchObject({ id: "yuki", revision: 3, persona: "kind" });
    expect(WaifuConfigSchema.parse(saved).scheduleInPrompt).toBe(false);
  });

  it("keeps the default (true) when the schedule block is enabled", async () => {
    const root = await freshRoot();
    await writeWaifu(root, "mio", { promptLayout: defaultWaifuPromptLayout() });

    await dropPromptLayoutFromWaifus(root);

    const saved = await readWaifu(root, "mio");
    expect(saved).not.toHaveProperty("promptLayout");
    expect(saved).not.toHaveProperty("scheduleInPrompt");
    expect(WaifuConfigSchema.parse(saved).scheduleInPrompt).toBe(true);
  });

  it("does not flip an existing scheduleInPrompt:false back on", async () => {
    const root = await freshRoot();
    await writeWaifu(root, "mio", { scheduleInPrompt: false, promptLayout: defaultWaifuPromptLayout() });
    await dropPromptLayoutFromWaifus(root);
    expect((await readWaifu(root, "mio")).scheduleInPrompt).toBe(false);
  });

  it("treats a schedule block inside a disabled group as disabled", async () => {
    const root = await freshRoot();
    const layout = layoutWith((value) => {
      value.top = [
        { kind: "block", blockId: "identity", enabled: true },
        {
          kind: "group",
          id: "g1",
          tag: "{name}_extras",
          enabled: false,
          children: [{ kind: "block", blockId: "schedule", enabled: true }]
        }
      ];
    });
    await writeWaifu(root, "rin", { promptLayout: layout });

    await dropPromptLayoutFromWaifus(root);

    const saved = await readWaifu(root, "rin");
    expect(saved.scheduleInPrompt).toBe(false);
    expect(saved).not.toHaveProperty("promptLayout");
  });

  it("treats a disabled schedule block inside an enabled group as disabled, but an enabled one as enabled", async () => {
    const root = await freshRoot();
    const group = (enabled: boolean) => ({
      kind: "group",
      id: "g",
      tag: "x",
      enabled: true,
      children: [{ kind: "block", blockId: "schedule", enabled }]
    });
    await writeWaifu(root, "off", { promptLayout: layoutWith((l) => { l.mid = [group(false)]; }) });
    await writeWaifu(root, "on", { promptLayout: layoutWith((l) => { l.mid = [group(true)]; }) });

    await dropPromptLayoutFromWaifus(root);

    expect((await readWaifu(root, "off")).scheduleInPrompt).toBe(false);
    expect(await readWaifu(root, "on")).not.toHaveProperty("scheduleInPrompt");
  });

  it("honors a legacy flat promptSections.schedule === false and deletes promptSections", async () => {
    const root = await freshRoot();
    await writeWaifu(root, "legacy", { promptSections: { hardRules: true, schedule: false } });
    await writeWaifu(root, "legacy-on", { promptSections: { schedule: true } });

    await dropPromptLayoutFromWaifus(root);

    const off = await readWaifu(root, "legacy");
    expect(off).not.toHaveProperty("promptSections");
    expect(off.scheduleInPrompt).toBe(false);
    const on = await readWaifu(root, "legacy-on");
    expect(on).not.toHaveProperty("promptSections");
    expect(on).not.toHaveProperty("scheduleInPrompt");
  });

  it("logs and ignores a disabled persona block", async () => {
    const root = await freshRoot();
    await writeWaifu(root, "quiet", { promptLayout: layoutWith((layout) => disableBlock(layout, "persona")) });
    const logged: string[] = [];

    await dropPromptLayoutFromWaifus(root, { onDisabledPersona: (waifu) => logged.push(waifu) });

    expect(logged).toEqual(["quiet"]);
    const saved = await readWaifu(root, "quiet");
    expect(saved).not.toHaveProperty("promptLayout");
    expect(saved).not.toHaveProperty("scheduleInPrompt");
    expect(saved.persona).toBe("kind");
  });

  it("leaves already-clean waifus byte-for-byte alone", async () => {
    const root = await freshRoot();
    await writeWaifu(root, "clean", { verbosity: "chatty", scheduleInPrompt: false });
    const before = await readFile(path.join(root, "user/waifus/clean/waifu.json"), "utf8");

    expect(await dropPromptLayoutFromWaifus(root)).toBe(0);
    expect(await migrateWaifuDropPromptLayout(root)).toBeUndefined();

    expect(await readFile(path.join(root, "user/waifus/clean/waifu.json"), "utf8")).toBe(before);
  });

  it.each([
    ["null layout", { promptLayout: null }],
    ["string layout", { promptLayout: "default" }],
    ["array layout", { promptLayout: [] }],
    ["layout with non-array slots", { promptLayout: { top: "x", mid: 4, trailing: null } }],
    ["layout with garbage nodes", { promptLayout: { top: [null, 7, "x", [], { kind: "group" }, { kind: "group", children: "no" }, { kind: "block" }], mid: [{ kind: "group", children: [null, { blockId: "schedule", enabled: false }] }], trailing: [] } }],
    ["numeric promptSections", { promptSections: 5 }],
    ["null promptSections", { promptSections: null }],
    ["array promptSections", { promptSections: [{ schedule: false }] }]
  ])("tolerates a garbage shape: %s", async (_label, extra) => {
    const root = await freshRoot();
    await writeWaifu(root, "weird", extra);

    await expect(dropPromptLayoutFromWaifus(root)).resolves.toBe(1);

    const saved = await readWaifu(root, "weird");
    expect(saved).not.toHaveProperty("promptLayout");
    expect(saved).not.toHaveProperty("promptSections");
    expect(saved).not.toHaveProperty("scheduleInPrompt");
  });

  it("skips non-object and unparsable waifu files without throwing", async () => {
    const root = await freshRoot();
    await mkdir(path.join(root, "user/waifus/arr"), { recursive: true });
    await writeFile(path.join(root, "user/waifus/arr/waifu.json"), "[]", "utf8");
    await mkdir(path.join(root, "user/waifus/bad"), { recursive: true });
    await writeFile(path.join(root, "user/waifus/bad/waifu.json"), "{nope", "utf8");
    await mkdir(path.join(root, "user/waifus/empty"), { recursive: true });

    await expect(dropPromptLayoutFromWaifus(root)).resolves.toBe(0);
  });

  it("returns 0 when there is no waifus directory", async () => {
    expect(await dropPromptLayoutFromWaifus(await freshRoot())).toBe(0);
  });

  it("is idempotent: a second run changes nothing", async () => {
    const root = await freshRoot();
    await writeWaifu(root, "a", { promptLayout: layoutWith((layout) => disableBlock(layout, "schedule")) });
    await writeWaifu(root, "b", { promptSections: { schedule: false } });

    expect(await migrateWaifuDropPromptLayout(root)).toBe("waifu-drop-prompt-layout-2");
    const afterFirst = [await readWaifu(root, "a"), await readWaifu(root, "b")];
    expect(await migrateWaifuDropPromptLayout(root)).toBeUndefined();
    expect([await readWaifu(root, "a"), await readWaifu(root, "b")]).toEqual(afterFirst);
  });

  it("keeps the schedule choice for every legacy shape through the real boot order", async () => {
    const root = await freshRoot();
    // W1 layout (legacy block ids) with schedule off.
    await writeWaifu(root, "w1", {
      promptLayout: {
        top: [
          { kind: "block", blockId: "personality", enabled: true },
          { kind: "block", blockId: "schedule", enabled: false }
        ],
        mid: [],
        trailing: []
      }
    });
    // Flat promptSections predate the layout tree.
    await writeWaifu(root, "flat", { promptSections: { hardRules: true, schedule: false } });
    const steps = MIGRATION_STEPS.filter((step) => !step.pending);

    await runMigrations(root, { appVersion: "2.200.0", steps });

    for (const id of ["w1", "flat"]) {
      const saved = await readWaifu(root, id);
      expect(saved, id).not.toHaveProperty("promptLayout");
      expect(saved, id).not.toHaveProperty("promptSections");
      expect(saved.scheduleInPrompt, id).toBe(false);
    }
  });
});
