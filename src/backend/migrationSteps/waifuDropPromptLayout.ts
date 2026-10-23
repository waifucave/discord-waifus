import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "../../storage/atomic.js";

// Step `waifu-drop-prompt-layout-v1` (spec 8.6). The prompt-layout editor is gone; the only layout
// choice that still has meaning is "don't mention her schedule", which becomes the waifu field
// `scheduleInPrompt: false`. A disabled `schedule` block (top level, or anywhere inside a disabled
// group), a disabled block inside an enabled group, or a legacy flat `promptSections.schedule ===
// false` all count. A disabled persona block is reported and otherwise ignored (the persona is
// always rendered). `promptLayout` and the legacy `promptSections` are deleted.
//
// The raw file is untyped on purpose: every legacy shape (W1 flat toggles, W2 layout tree, and
// hand-edited/garbage values) must be tolerated, so nothing here goes through the zod schemas.

export type DropPromptLayoutOptions = {
  // Called once per waifu whose persona block was disabled in the legacy layout.
  onDisabledPersona?: (waifuDir: string) => void;
};

const LAYOUT_SLOTS = ["top", "mid", "trailing"] as const;

type LayoutFacts = { scheduleDisabled: boolean; personaDisabled: boolean };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inspectBlock(node: Record<string, unknown>, parentDisabled: boolean, facts: LayoutFacts): void {
  const disabled = parentDisabled || node.enabled === false;
  if (!disabled) return;
  if (node.blockId === "schedule") facts.scheduleDisabled = true;
  if (node.blockId === "persona") facts.personaDisabled = true;
}

function inspectNodes(nodes: unknown, facts: LayoutFacts): void {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    if (!isObject(node)) continue;
    if (node.kind === "block") {
      inspectBlock(node, false, facts);
    } else if (node.kind === "group" && Array.isArray(node.children)) {
      const groupDisabled = node.enabled === false;
      for (const child of node.children) {
        if (isObject(child) && child.kind === "block") inspectBlock(child, groupDisabled, facts);
      }
    }
  }
}

function inspectLayout(layout: unknown): LayoutFacts {
  const facts: LayoutFacts = { scheduleDisabled: false, personaDisabled: false };
  if (!isObject(layout)) return facts;
  for (const slot of LAYOUT_SLOTS) inspectNodes(layout[slot], facts);
  return facts;
}

// True when a (raw, untrusted) legacy layout has its schedule block disabled. The older layout
// migrations in ../migrations.ts use this so they never discard the flag before this step runs.
export function layoutHasScheduleDisabled(layout: unknown): boolean {
  return inspectLayout(layout).scheduleDisabled;
}

async function readJson(filePath: string): Promise<unknown | undefined> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
  try {
    return JSON.parse(content);
  } catch {
    // An unparsable waifu.json is not this step's problem; the loader reports it.
    return undefined;
  }
}

// Returns the number of waifu files rewritten.
export async function dropPromptLayoutFromWaifus(
  dataRoot: string,
  options: DropPromptLayoutOptions = {}
): Promise<number> {
  const waifusRoot = path.join(dataRoot, "user", "waifus");
  let entries: string[];
  try {
    entries = await readdir(waifusRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let count = 0;
  for (const entry of entries) {
    const filePath = path.join(waifusRoot, entry, "waifu.json");
    const data = await readJson(filePath);
    if (!isObject(data)) continue;
    const hasLayout = Object.hasOwn(data, "promptLayout");
    const hasSections = Object.hasOwn(data, "promptSections");
    if (!hasLayout && !hasSections) continue; // already clean

    const facts = inspectLayout(data.promptLayout);
    const legacyScheduleOff = isObject(data.promptSections) && data.promptSections.schedule === false;
    if (facts.personaDisabled) options.onDisabledPersona?.(entry);
    if (facts.scheduleDisabled || legacyScheduleOff) data.scheduleInPrompt = false;
    delete data.promptLayout;
    delete data.promptSections;
    await atomicWriteJson(filePath, data);
    count += 1;
  }
  return count;
}

export async function migrateWaifuDropPromptLayout(dataRoot: string): Promise<string | undefined> {
  const count = await dropPromptLayoutFromWaifus(dataRoot, {
    onDisabledPersona: (waifuDir) =>
      console.warn(
        `[migration] waifu ${waifuDir}: persona block was disabled in the removed prompt layout; ignoring (the persona is always included).`
      )
  });
  return count > 0 ? `waifu-drop-prompt-layout-${count}` : undefined;
}
