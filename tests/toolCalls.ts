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

/**
 * §30's free functions written over `tools.wakeup`, for tests that only set wakeups up: `at(when,
 * note)`, `every(when, note)`, `watch(places, filter, options, note)` (an object filter's fields or a
 * function), `page(url, check, options, note)` and `cancel(id)` collect items, and one
 * `tools.wakeup` call saves them at the end. Tests of the tool itself call `tools.wakeup` directly.
 */
const OLD_WAKEUP_PRELUDE = [
  "const __w = { at: [], every: [], watch: [], page: [], cancel: [] };",
  "function at(when, note) { __w.at.push({ when, note }); }",
  "function every(when, note) { __w.every.push({ when, note }); }",
  "function watch(places, filter, options, note) { const item = { places, ...(options || {}), note }; if (typeof filter === 'function') item.filter = filter; else Object.assign(item, filter); __w.watch.push(item); }",
  "function page(url, check, options, note) { const item = { url, ...(options || {}), note }; if (typeof check === 'function') item.check = check; else if (check === 'changes') item.changes = true; else Object.assign(item, check); __w.page.push(item); }",
  "function cancel(id) { __w.cancel.push(id); }",
  ""
].join(" ");

export const wakeupCalls = (ctx: ToolContext, script: string) =>
  runScript("Wakeup", `${OLD_WAKEUP_PRELUDE}${script}\n;text(await tools.wakeup(Object.fromEntries(Object.entries(__w).filter(([, v]) => v.length > 0))));`, ctx);

/** `text(await tools.wakeup(<arg as JavaScript source>))`. */
export const wakeupCall = (ctx: ToolContext, arg: string) => runScript("Wakeup", `text(await tools.wakeup(${arg}))`, ctx);
