// Sessions outside her life (Living cast spec §7.3, §16.8, §18.4): nightly dreaming (`dream.ts`) and
// the notes-scrub session of a forget (§7.5 step 4). Each is a separate short session, never her life
// log: an instruction, only her file tools (Read, Edit, Bash with /transcripts read-only; no
// messaging, no web), purpose `maintenance`. The scrub session keeps her identity and persona; the
// dream is a memory keeper with neither (T3).

import type { ContentBlockLike, ProviderMessageLike } from "@yanlinglabs/winter-provider-runtime";
import type { CuratedModel } from "../models/catalog.js";
import { ModelCallError } from "../models/errors.js";
import type { WaifuConfig } from "../shared/schemas/domain.js";
import { timeLine } from "./clock.js";
import type { LifeDeps } from "./deps.js";
import { homeStoreFor } from "./home/index.js";
import { availabilityFor } from "./busy.js";
import { LIFE_DIR, PLACES_FILE, PROFILE_FILE } from "./home/pathRules.js";
import { lifeTool, maintenanceToolNames, modelTools } from "./tools/index.js";
import { toolError, type ToolOutput } from "./tools/types.js";

/** A forget's notes scrub: at most this many tool rounds. */
export const MAINTENANCE_MAX_ROUNDS = 30;

/** The session's opening file listing names at most this many files. */
export const MAINTENANCE_LISTING_MAX = 200;

export function scrubInstruction(o: { userId: string; names: readonly string[] }): string {
  const who = o.names.length > 0 ? `${o.names.map((name) => `"${name}"`).join(", ")} (<@${o.userId}>)` : `<@${o.userId}>`;
  return `[system] Someone asked to be forgotten: ${who}. Remove everything about them from your home: delete notes that are about them, remove every line and sentence that mentions them from your other files, and update MEMORY.md. Keep no trace of them, not even that they asked. When you're done, reply with one short line saying what you changed.`;
}

/** System block of a forget's notes scrub: who she is, without the life harness. */
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

/** `Your files: ~/a.md, ~/b.md` (every file of her home, pictures too, the first 200 by name). */
export async function homeListing(deps: LifeDeps, waifu: WaifuConfig, o: { possessive?: string } = {}): Promise<string> {
  const store = homeStoreFor(deps, waifu);
  const all = (await store.files.walk("home").catch(() => [])).filter((entry) => entry.kind === "file").map((entry) => entry.path.segments.join("/")).sort();
  const listing = all.slice(0, MAINTENANCE_LISTING_MAX);
  const more = all.length - listing.length;
  const whose = o.possessive ?? "Your";
  return listing.length > 0
    ? `${whose} files: ${listing.map((name) => `~/${name}`).join(", ")}${more > 0 ? `, … and ${more} more; use \`ls -R\`` : ""}`
    : `${whose === "Your" ? "Your" : whose} home is empty.`;
}

/** One session over her home with her file tools; never throws for model failures (the outcome says so). */
export async function runSession(
  deps: LifeDeps,
  o: {
    waifu: WaifuConfig;
    model: CuratedModel;
    system: string;
    /** The opening message's text blocks. */
    opening: string[];
    maxRounds: number;
    effort?: string;
    signal?: AbortSignal;
    kind: "maintenance" | "scrub" | "dream";
  }
): Promise<MaintenanceOutcome> {
  const store = homeStoreFor(deps, o.waifu);
  const before = new Map(await store.readAllText());
  const toolNames = maintenanceToolNames(deps.config());
  const messages: ProviderMessageLike[] = [{ role: "user", content: o.opening.map((text) => ({ type: "text" as const, text })) }];
  const tools = modelTools(toolNames, deps.config());
  // One scratch for the whole session (what she read of her special files stays known across it).
  const turn = { id: `${o.kind}-${deps.now().getTime()}`, sentPlaces: new Set<string>(), dmUsersSent: new Set<string>(), fetches: 0 };
  let rounds = 0;
  let summary = "";
  try {
    for (; rounds < o.maxRounds; ) {
      const result = await deps.models.call({
        route: { providerId: o.model.providerId, modelId: o.model.modelId },
        system: [o.system],
        messages,
        tools,
        ...(o.effort ? { effort: o.effort } : {}),
        cacheKey: `${o.kind === "dream" ? "dream" : "maintenance"}:${o.waifu.id}`,
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
              session: o.kind,
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

/** A forget's notes scrub session (her identity and persona, her files listed, her clock). */
export async function runNotesSession(
  deps: LifeDeps,
  o: { waifu: WaifuConfig; model: CuratedModel; instruction: string; signal?: AbortSignal; kind: "maintenance" | "scrub"; effort?: string | undefined }
): Promise<MaintenanceOutcome> {
  // A caller that names the effort (even as undefined) chose the route with it: `life.dreamModel`
  // carries its own effort or none, never hers. Without the key the session runs on her model with hers.
  const effort = "effort" in o ? o.effort : o.waifu.model?.effort;
  return runSession(deps, {
    waifu: o.waifu,
    model: o.model,
    system: maintenanceSystem(o.waifu),
    opening: [o.instruction, await homeListing(deps, o.waifu), timeLine({ now: deps.now(), timeZone: deps.timeZone, status: await availabilityFor(deps, o.waifu, deps.now()) })],
    maxRounds: MAINTENANCE_MAX_ROUNDS,
    ...(effort ? { effort } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
    kind: o.kind
  });
}

/**
 * What she changed: places.md and profile.json are the app's to rewrite (a session can't change
 * either), so the scheduler's refresh during the session isn't hers.
 */
const APP_REWRITTEN = new Set([`${LIFE_DIR}/${PLACES_FILE}`, `${LIFE_DIR}/${PROFILE_FILE}`]);
function changedPaths(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => !APP_REWRITTEN.has(path) && before.get(path) !== after.get(path)).sort();
}
