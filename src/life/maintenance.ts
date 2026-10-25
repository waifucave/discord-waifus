// Nightly maintenance (Living cast spec §7.3, §16.8) and the notes-scrub session of a forget (§7.5
// step 4): a separate short session, not her life log — her model, her identity and persona, an
// instruction, only her file tools (Read, Write, Edit, Bash; no messaging, no web), purpose
// `maintenance`, at most 30 tool rounds. One report line goes to `maintenance.jsonl`.

import type { ContentBlockLike, ProviderMessageLike } from "@yanlinglabs/winter-provider-runtime";
import type { CuratedModel } from "../models/catalog.js";
import { ModelCallError } from "../models/errors.js";
import type { WaifuConfig } from "../shared/schemas/domain.js";
import { timeLine } from "./clock.js";
import type { LifeDeps } from "./deps.js";
import { homeStoreFor } from "./home/index.js";
import { PLACES_FILE } from "./home/pathRules.js";
import { appendMaintenanceReport } from "./lifeStore.js";
import { lifeTool, maintenanceToolNames, modelTools } from "./tools/index.js";
import { toolError, type ToolOutput } from "./tools/types.js";

export const MAINTENANCE_MAX_ROUNDS = 30;

/** The session's opening file listing names at most this many files. */
export const MAINTENANCE_LISTING_MAX = 200;

export const MAINTENANCE_INSTRUCTION =
  "[system] It's quiet; time to tidy your home. Resolve contradictions in your notes (the newest fact wins), merge duplicates, merge or delete notes that are stale, fix broken links in MEMORY.md and keep it short: one line per note, well under 200 lines. Remove reminders and watches you no longer need from schedule.json and watches.json; edit those two carefully: a broken file is refused with the line and column. /tmp cleans itself. When you're done, reply with one short line saying what you changed.";

export function scrubInstruction(o: { userId: string; names: readonly string[] }): string {
  const who = o.names.length > 0 ? `${o.names.map((name) => `"${name}"`).join(", ")} (<@${o.userId}>)` : `<@${o.userId}>`;
  return `[system] Someone asked to be forgotten: ${who}. Remove everything about them from your home: delete notes that are about them, remove every line and sentence that mentions them from your other files, and update MEMORY.md. Keep no trace of them, not even that they asked. When you're done, reply with one short line saying what you changed.`;
}

/** System block of a maintenance session: who she is, without the life harness. */
export function maintenanceSystem(waifu: WaifuConfig): string {
  const parts = [
    `<maintenance>\nYou are ${waifu.name}, looking after your own folder, your home: your notes are real files only you write. MEMORY.md is your index, one short line per note with a link to the details. Nobody else sees this session.\n</maintenance>`
  ];
  if (waifu.persona.trim()) parts.push(`<persona>\n${waifu.persona.trim()}\n</persona>`);
  return parts.join("\n\n");
}

export type MaintenanceOutcome = {
  rounds: number;
  changed: string[];
  summary: string;
  ok: boolean;
  error?: string;
};

/** One session over her home; never throws for model failures (the outcome says so). */
export async function runNotesSession(
  deps: LifeDeps,
  o: { waifu: WaifuConfig; model: CuratedModel; instruction: string; signal?: AbortSignal; kind: "maintenance" | "scrub" }
): Promise<MaintenanceOutcome> {
  const store = homeStoreFor(deps, o.waifu);
  const before = new Map(await store.readAllText());
  // Every file of her home (pictures and large files too), the first MAINTENANCE_LISTING_MAX by name.
  const all = (await store.files.walk("home").catch(() => [])).filter((entry) => entry.kind === "file").map((entry) => entry.path.segments.join("/")).sort();
  const listing = all.slice(0, MAINTENANCE_LISTING_MAX);
  const more = all.length - listing.length;
  const toolNames = maintenanceToolNames(deps.config());
  const messages: ProviderMessageLike[] = [
    {
      role: "user",
      content: [
        { type: "text", text: o.instruction },
        {
          type: "text",
          text: listing.length > 0 ? `Your files: ${listing.map((name) => `~/${name}`).join(", ")}${more > 0 ? `, … and ${more} more; use \`ls -R\`` : ""}` : "Your home is empty."
        },
        { type: "text", text: timeLine({ now: deps.now(), timeZone: deps.timeZone, availability: o.waifu.availability }) }
      ]
    }
  ];
  const tools = modelTools(toolNames, deps.config());
  // One scratch for the whole session (a Read earlier in it lets a later Write replace a special file).
  const turn = { id: `${o.kind}-${deps.now().getTime()}`, sentPlaces: new Set<string>(), dmUsersSent: new Set<string>(), fetches: 0 };
  let rounds = 0;
  let summary = "";
  try {
    for (; rounds < MAINTENANCE_MAX_ROUNDS; ) {
      const result = await deps.models.call({
        route: { providerId: o.model.providerId, modelId: o.model.modelId },
        system: [maintenanceSystem(o.waifu)],
        messages,
        tools,
        ...(o.waifu.model?.effort ? { effort: o.waifu.model.effort } : {}),
        cacheKey: `maintenance:${o.waifu.id}`,
        ...(o.signal ? { signal: o.signal } : {}),
        attribution: { purpose: "maintenance", waifuId: o.waifu.id }
      });
      rounds += 1;
      messages.push(result.message);
      summary = result.text.trim() || summary;
      if (result.toolCalls.length === 0 || result.finishReason === "refusal") break;
      const results: ContentBlockLike[] = [];
      for (const call of result.toolCalls) {
        const tool = toolNames.includes(call.name) ? lifeTool(call.name) : undefined;
        let output: ToolOutput;
        if (!tool) output = toolError(`there is no tool called ${call.name}`);
        else {
          try {
            output = await tool.run(call.input, {
              deps,
              waifu: o.waifu,
              route: o.model,
              turn,
              mode: "session",
              signal: o.signal ?? new AbortController().signal,
              toolCallId: call.id,
              selfAuthorIds: [],
              toolNames
            });
          } catch (error) {
            deps.logger.warn("Maintenance tool failed", { waifuId: o.waifu.id, tool: call.name, message: error instanceof Error ? error.message : String(error) });
            output = toolError("something went wrong");
          }
        }
        // Images Read shows are text here: this session never resolves image blocks.
        const content = typeof output.content === "string" ? output.content : output.content.map((block) => (block.type === "text" ? block.text : block.mode === "inline" ? "[image]" : block.mode.text)).join("\n");
        results.push({ type: "tool_result", tool_use_id: call.id, content, ...(output.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: "user", content: results });
    }
  } catch (error) {
    const kind = error instanceof ModelCallError ? error.kind : "other";
    const after = await store.readAllText();
    return { rounds, changed: changedPaths(before, after), summary, ok: false, error: kind };
  }
  const after = await store.readAllText();
  return { rounds, changed: changedPaths(before, after), summary: summary.slice(0, 500), ok: true };
}

/** What she changed: places.md is the app's to rewrite (she can't), so a refresh during the session isn't hers. */
function changedPaths(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => path !== PLACES_FILE && before.get(path) !== after.get(path)).sort();
}

/** The nightly session plus its report line. */
export async function runMaintenance(deps: LifeDeps, o: { waifu: WaifuConfig; model: CuratedModel; signal?: AbortSignal }): Promise<MaintenanceOutcome> {
  const outcome = await runNotesSession(deps, { ...o, instruction: MAINTENANCE_INSTRUCTION, kind: "maintenance" });
  await appendMaintenanceReport(deps.storage, o.waifu.id, {
    at: deps.now().toISOString(),
    kind: "maintenance",
    ok: outcome.ok,
    rounds: outcome.rounds,
    changed: outcome.changed,
    summary: outcome.summary,
    ...(outcome.error ? { error: outcome.error } : {})
  });
  deps.logger.info("Life maintenance ran", { category: "life", waifuId: o.waifu.id, ok: outcome.ok, rounds: outcome.rounds, changed: outcome.changed.length });
  return outcome;
}
