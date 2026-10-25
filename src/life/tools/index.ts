// The tools a life is offered (Living cast spec §16.3): eleven, in a fixed order so the tool list is
// part of the epoch's stable prefix. `WebSearch` / `WebFetch` are offered only while their caps
// allow them, `Bash` only while `life.bash.enabled` is on.

import type { ModelTool } from "../../models/client.js";
import type { AppConfig } from "../../shared/schemas/config.js";
import type { LifeDeps } from "../deps.js";
import { bashTool_ } from "./bash.js";
import { fileTools } from "./files.js";
import { messageTools } from "./messages.js";
import { planningTools } from "./planning.js";
import type { LifeTool } from "./types.js";
import { webTools } from "./web.js";

export const ALL_LIFE_TOOLS: readonly LifeTool[] = [...messageTools, ...planningTools, ...fileTools, bashTool_, ...webTools];

/** The tools nightly maintenance and a forget's notes scrub get (§16.8): her files only. */
export const MAINTENANCE_TOOL_NAMES = ["Read", "Write", "Edit", "Bash"] as const;

/** The tool names offered to a life right now. */
export function offeredToolNames(deps: Pick<LifeDeps, "web" | "config">): string[] {
  return ALL_LIFE_TOOLS.filter((tool) => {
    if (tool.name === "WebSearch") return deps.web?.searchOffered() === true;
    if (tool.name === "WebFetch") return deps.web?.fetchOffered() === true;
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
    return [{ name: tool.name, description: config && tool.describe ? tool.describe(config) : tool.description, inputSchema: tool.inputSchema }];
  });
}

export type { LifeTool };
