// Nightly maintenance (Living cast spec §7.3) and the notes-scrub session of a forget (§7.5 step 4):
// a separate short session, not her life log — her model, her identity and persona, an
// instruction, only the notes tools, purpose `maintenance`, at most 30 tool rounds. One report line
// goes to `maintenance.jsonl`.

import type { ContentBlockLike, ProviderMessageLike } from "@yanlinglabs/winter-provider-runtime";
import type { CuratedModel } from "../models/catalog.js";
import { ModelCallError } from "../models/errors.js";
import type { WaifuConfig } from "../shared/schemas/domain.js";
import { timeLine } from "./clock.js";
import type { LifeDeps } from "./deps.js";
import { appendMaintenanceReport } from "./lifeStore.js";
import { Notes } from "./notes.js";
import { modelTools } from "./tools/index.js";
import { NOTE_TOOL_NAMES, noteTools } from "./tools/notes.js";
import { toolError, type ToolOutput } from "./tools/types.js";

export const MAINTENANCE_MAX_ROUNDS = 30;

export const MAINTENANCE_INSTRUCTION =
  "[system] It's quiet; time to tidy your notes. Resolve contradictions (the newest fact wins), merge duplicates, fix broken links in MEMORY.md, prune stale trivia, and keep MEMORY.md short: one line per note, well under 200 lines. Use only your notes tools. When you're done, reply with one short line saying what you changed.";

export function scrubInstruction(o: { userId: string; names: readonly string[] }): string {
  const who = o.names.length > 0 ? `${o.names.map((name) => `"${name}"`).join(", ")} (<@${o.userId}>)` : `<@${o.userId}>`;
  return `[system] Someone asked to be forgotten: ${who}. Remove everything about them from your notes: delete notes that are about them, remove every line and sentence that mentions them from your other notes, and update MEMORY.md. Keep no trace of them, not even that they asked. Use only your notes tools. When you're done, reply with one short line saying what you changed.`;
}

/** System block of a maintenance session: who she is, without the life harness. */
export function maintenanceSystem(waifu: WaifuConfig): string {
  const parts = [
    `<maintenance>\nYou are ${waifu.name}, looking after your own notes: real Markdown files only you write. MEMORY.md is your index, one short line per note with a link to the details. Nobody else sees this session.\n</maintenance>`
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

/** One session over her notes; never throws for model failures (the outcome says so). */
export async function runNotesSession(
  deps: LifeDeps,
  o: { waifu: WaifuConfig; model: CuratedModel; instruction: string; signal?: AbortSignal; kind: "maintenance" | "scrub" }
): Promise<MaintenanceOutcome> {
  const notes = new Notes(deps.storage, o.waifu.id);
  const before = new Map(await notes.readAll());
  const listing = [...before.keys()];
  const messages: ProviderMessageLike[] = [
    {
      role: "user",
      content: [
        { type: "text", text: o.instruction },
        { type: "text", text: listing.length > 0 ? `Your notes: ${listing.join(", ")}` : "You have no notes yet." },
        { type: "text", text: timeLine({ now: deps.now(), timeZone: deps.timeZone, availability: o.waifu.availability }) }
      ]
    }
  ];
  const tools = modelTools([...NOTE_TOOL_NAMES]);
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
        const tool = noteTools.find((candidate) => candidate.name === call.name);
        let output: ToolOutput;
        if (!tool) output = toolError(`there is no tool called ${call.name}`);
        else {
          try {
            output = await tool.run(call.input, {
              deps,
              waifu: o.waifu,
              route: o.model,
              turn: { id: `maintenance-${rounds}`, sentPlaces: new Set(), dmUsersSent: new Set(), fetches: 0 },
              signal: o.signal ?? new AbortController().signal,
              toolCallId: call.id,
              selfAuthorIds: [],
              toolNames: [...NOTE_TOOL_NAMES]
            });
          } catch (error) {
            deps.logger.warn("Maintenance tool failed", { waifuId: o.waifu.id, tool: call.name, message: error instanceof Error ? error.message : String(error) });
            output = toolError("something went wrong");
          }
        }
        results.push({ type: "tool_result", tool_use_id: call.id, content: output.content as string, ...(output.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: "user", content: results });
    }
  } catch (error) {
    const kind = error instanceof ModelCallError ? error.kind : "other";
    const after = await notes.readAll();
    return { rounds, changed: changedPaths(before, after), summary, ok: false, error: kind };
  }
  const after = await notes.readAll();
  return { rounds, changed: changedPaths(before, after), summary: summary.slice(0, 500), ok: true };
}

function changedPaths(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path)).sort();
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
