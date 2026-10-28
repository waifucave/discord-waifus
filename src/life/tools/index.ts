// The tools a life is offered (Living cast spec §16.3, §30, §31): nine, in a fixed order so the tool
// list is part of the epoch's stable prefix. `Web` is offered while search or page fetching is (a cap
// above 0), `Bash` only while `life.bash.enabled` is on.

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

/** The tools nightly maintenance and a forget's notes scrub get (§16.8): her files only. */
export const MAINTENANCE_TOOL_NAMES = ["Read", "Write", "Edit", "Bash"] as const;

/** The tool names offered to a life right now. */
export function offeredToolNames(deps: Pick<LifeDeps, "web" | "config">): string[] {
  return ALL_LIFE_TOOLS.filter((tool) => {
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
