// The tools a life is offered (Living cast spec §6), in a fixed order so the tool list is part of
// the epoch's stable prefix. web_search / web_fetch are offered only while their caps allow them.

import type { ModelTool } from "../../models/client.js";
import type { LifeDeps } from "../deps.js";
import { messageTools } from "./messages.js";
import { noteTools } from "./notes.js";
import { planningTools } from "./planning.js";
import type { LifeTool } from "./types.js";
import { placesTool, webTools } from "./web.js";

export const ALL_LIFE_TOOLS: readonly LifeTool[] = [...messageTools, ...planningTools, ...noteTools, ...webTools, placesTool];

/** The tool names offered to a life right now. */
export function offeredToolNames(deps: Pick<LifeDeps, "web">): string[] {
  return ALL_LIFE_TOOLS.filter((tool) => {
    if (tool.name === "web_search") return deps.web?.searchOffered() === true;
    if (tool.name === "web_fetch") return deps.web?.fetchOffered() === true;
    return true;
  }).map((tool) => tool.name);
}

export function lifeTool(name: string): LifeTool | undefined {
  return ALL_LIFE_TOOLS.find((tool) => tool.name === name);
}

/** The model-facing definitions of `names`, in order. */
export function modelTools(names: readonly string[]): ModelTool[] {
  return names.flatMap((name) => {
    const tool = lifeTool(name);
    return tool ? [{ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }] : [];
  });
}

export { noteTools };
export type { LifeTool };
