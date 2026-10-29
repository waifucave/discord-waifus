// The §32 tool calls as tests write them: each tool takes a script calling its own `tools.*`
// function; these build the script from plain arguments and run the tool directly.
import { lifeTool } from "../src/life/tools/index.js";
import type { ToolContext, ToolOutput } from "../src/life/tools/types.js";

/** A tool run with one script. */
export const runScript = (tool: string, script: string, ctx: ToolContext): Promise<ToolOutput> => lifeTool(tool)!.run({ script }, ctx);

/**
 * The output with the host's receipts (§32.3a) taken out of its text and kept on `receipts` (not
 * enumerable, so `toEqual` against `{ content, isError }` still works).
 */
export function receiptsApart(output: ToolOutput): ToolOutput & { receipts?: string[] } {
  if (typeof output.content !== "string") return output;
  const apart = { ...output, content: withoutReceipts(output.content) };
  Object.defineProperty(apart, "receipts", { value: receiptsOf(output.content), enumerable: false });
  return apart;
}

/** `text(await tools.<fn>(<arg as JSON>))` for a tool (its receipts apart). */
export const callTool = async (tool: string, fn: string, arg: unknown, ctx: ToolContext): Promise<ToolOutput & { receipts?: string[] }> =>
  receiptsApart(await runScript(tool, `text(await tools.${fn}(${JSON.stringify(arg)}))`, ctx));

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

/** A tool script's output without the host's receipts (§32.3a), and the receipts alone. */
export const withoutReceipts = (text: string) => text.split("\n").filter((line) => !line.startsWith("[receipt] ")).join("\n");
export const receiptsOf = (text: string) => text.split("\n").filter((line) => line.startsWith("[receipt] ")).map((line) => line.slice("[receipt] ".length));

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

export const wakeupCalls = async (ctx: ToolContext, script: string): Promise<ToolOutput> => {
  // What was saved, as §30's result said it (`set w1 (…) (in ~/life/wakeups.json)`): the receipt.
  const output = await runScript("Wakeup", `${OLD_WAKEUP_PRELUDE}${script}\n;await tools.wakeup(Object.fromEntries(Object.entries(__w).filter(([, v]) => v.length > 0)));`, ctx);
  if (typeof output.content !== "string") return output;
  const saved = receiptsOf(output.content).flatMap((receipt) => (receipt.startsWith("wakeup: saved: ") ? [receipt.slice("wakeup: saved: ".length)] : []));
  return output.isError ? { ...output, content: withoutReceipts(output.content) } : { ...output, content: saved.join("\n") || withoutReceipts(output.content) };
};

/** `text(await tools.wakeup(<arg as JavaScript source>))`. */
export const wakeupCall = async (ctx: ToolContext, arg: string) => receiptsApart(await runScript("Wakeup", `text(await tools.wakeup(${arg}))`, ctx));

/** A tool call's input for a scripted model turn (`toolTurn([{ name, input: scriptInput.readFile(…) }])`). */
export const scriptInput = {
  readMessages: (arg: Record<string, unknown>) => ({ script: `text(await tools.read_messages(${JSON.stringify(arg)}))` }),
  sendMessage: (place: string, messages: unknown[]) => ({ script: `text(await tools.send_message(${JSON.stringify({ place, messages })}))` }),
  readFile: (arg: Record<string, unknown> | string) => ({ script: `text(await tools.read_file(${JSON.stringify(typeof arg === "string" ? { path: arg } : arg)}))` }),
  applyPatch: (patch: string) => ({ script: `text(await tools.apply_patch(${JSON.stringify(patch)}))` }),
  web: (arg: Record<string, unknown>) => ({ script: `text(await tools.web__run(${JSON.stringify(arg)}))` })
};

/** A patch that changes one file: each `[old, new]` pair is one chunk (old lines out, new lines in). */
export const updateFilePatch = (path: string, ...changes: Array<[string, string]>) =>
  `*** Begin Patch\n*** Update File: ${path}\n${changes
    .map(([from, to]) => ["@@", ...from.replace(/\n$/u, "").split("\n").map((line) => `-${line}`), ...to.replace(/\n$/u, "").split("\n").map((line) => `+${line}`)].join("\n"))
    .join("\n")}\n*** End Patch`;

/** A patch that changes `from` to `to` on the first line of `content` (her file as it is) holding it. */
export const lineEditPatch = (path: string, content: string, from: string, to: string) => {
  const line = content.split("\n").find((entry) => entry.includes(from));
  if (line === undefined) throw new Error(`no line of ${path} holds ${from}`);
  return updateFilePatch(path, [line, line.replace(from, to)]);
};
