// The tools a life is offered (Living cast spec §16.3, §30, §31, §32): seven, in a fixed order so the
// tool list is part of the epoch's stable prefix. All but Bash take one JavaScript `script` calling
// their own `tools.*` function (§32). `Web` is offered while search or page fetching is (a cap above
// 0), `Bash` only while `life.bash.enabled` is on. `React` and `Write` are kept (old log lines still
// read) but no longer offered: `send_message` reacts and `apply_patch` adds files.

import type { ModelTool } from "../../models/client.js";
import type { AppConfig } from "../../shared/schemas/config.js";
import type { LifeDeps } from "../deps.js";
import { bashTool_ } from "./bash.js";
import { fileTools } from "./files.js";
import { messageTools } from "./messages.js";
import type { LifeTool } from "./types.js";
import { wakeupTool } from "./wakeup.js";
import { webTool } from "./web.js";

export const ALL_LIFE_TOOLS: readonly LifeTool[] = [...messageTools, wakeupTool, ...fileTools, bashTool_, webTool];

/** The tools nightly maintenance and a forget's notes scrub get (§16.8, §32.3): her files only. */
export const MAINTENANCE_TOOL_NAMES = ["Read", "Edit", "Bash"] as const;

/** Tools kept in the code but never offered since §32. */
export const UNOFFERED_TOOL_NAMES: ReadonlySet<string> = new Set(["React", "Write"]);

/** A tool a life can be offered now (an epoch offering any other is summarised first, §31.4). */
export function offerableTool(name: string): boolean {
  return lifeTool(name) !== undefined && !UNOFFERED_TOOL_NAMES.has(name);
}

/** The tool names offered to a life right now. */
export function offeredToolNames(deps: Pick<LifeDeps, "web" | "config">): string[] {
  return ALL_LIFE_TOOLS.filter((tool) => {
    if (UNOFFERED_TOOL_NAMES.has(tool.name)) return false;
    if (tool.name === "Web") return deps.web !== undefined && (deps.web.searchOffered() || deps.web.fetchOffered());
    if (tool.name === "Bash") return deps.config().life.bash.enabled;
    return true;
  }).map((tool) => tool.name);
}

/** The maintenance tools offered right now (Bash only while it is on). */
export function maintenanceToolNames(config: AppConfig): string[] {
  return MAINTENANCE_TOOL_NAMES.filter((name) => name !== "Bash" || config.life.bash.enabled);
}

export function lifeTool(name: string): LifeTool | undefined {
  return ALL_LIFE_TOOLS.find((tool) => tool.name === name);
}

/** The model-facing definitions of `names`, in order (descriptions under `config` when given). */
export function modelTools(names: readonly string[], config?: AppConfig): ModelTool[] {
  return names.flatMap((name) => {
    const tool = lifeTool(name);
    if (!tool) return [];
    return [
      {
        name: tool.name,
        description: config && tool.describe ? tool.describe(config) : tool.description,
        inputSchema: config && tool.schemaFor ? tool.schemaFor(config) : tool.inputSchema
      }
    ];
  });
}

export type { LifeTool };
