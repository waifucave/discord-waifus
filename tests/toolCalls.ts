// The §32 tool calls as tests write them: each tool takes a script calling its own `tools.*`
// function; these build the script from plain arguments and run the tool directly.
import { lifeTool } from "../src/life/tools/index.js";
import type { ToolContext, ToolOutput } from "../src/life/tools/types.js";

/** A tool run with one script. */
export const runScript = (tool: string, script: string, ctx: ToolContext): Promise<ToolOutput> => lifeTool(tool)!.run({ script }, ctx);

/** `text(await tools.<fn>(<arg as JSON>))` for a tool. */
export const callTool = (tool: string, fn: string, arg: unknown, ctx: ToolContext): Promise<ToolOutput> => runScript(tool, `text(await tools.${fn}(${JSON.stringify(arg)}))`, ctx);

export const readMessages = (ctx: ToolContext, arg: Record<string, unknown>) => callTool("ReadMessages", "read_messages", arg, ctx);
export const sendMessage = (ctx: ToolContext, place: string, messages: unknown[]) => callTool("SendMessage", "send_message", { place, messages }, ctx);
export const readFile = (ctx: ToolContext, arg: Record<string, unknown> | string) => callTool("Read", "read_file", typeof arg === "string" ? { path: arg } : arg, ctx);
export const applyPatch = (ctx: ToolContext, patch: string) => callTool("Edit", "apply_patch", patch, ctx);
export const webRun = (ctx: ToolContext, arg: Record<string, unknown>) => callTool("Web", "web__run", arg, ctx);

/** A patch that adds one file (`+` before each line). */
export const addFilePatch = (path: string, content: string) => `*** Begin Patch\n*** Add File: ${path}\n${content.replace(/\n$/u, "").split("\n").map((line) => `+${line}`).join("\n")}\n*** End Patch`;

/** A patch that replaces one file whole: delete it, add it again with the new text. */
export const replaceFilePatch = (path: string, content: string) =>
  `*** Begin Patch\n*** Delete File: ${path}\n*** Add File: ${path}\n${content.replace(/\n$/u, "").split("\n").map((line) => `+${line}`).join("\n")}\n*** End Patch`;

/** The text of a tool's output (images as `[image]`). */
export const outputText = (output: ToolOutput) => (typeof output.content === "string" ? output.content : output.content.map((block) => ("text" in block ? block.text : "[image]")).join("\n"));
