// Model warnings the owner must act on (Living cast spec §9.2, §9.4): a migrated model with no
// curated equivalent, or a stored effort the route no longer lists. Persisted in
// `app/model-warnings.json` by the migration and the boot check, shown in `/api/runtime`, and
// cleared for a scope when the owner saves a model for it.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicWriteJson } from "../storage/atomic.js";

export const ModelWarningSchema = z.object({
  /** `waifu:<id>` or `assistant`. */
  scope: z.string().min(1),
  code: z.enum(["model_unmapped", "effort_dropped"]),
  detail: z.string(),
  at: z.string()
});
export type ModelWarning = z.infer<typeof ModelWarningSchema>;

const ModelWarningsFileSchema = z.object({ warnings: z.array(ModelWarningSchema).default([]) });

const MAX_WARNINGS = 200;

export function modelWarningsPath(dataRoot: string): string {
  return path.join(dataRoot, "app", "model-warnings.json");
}

export async function readModelWarnings(dataRoot: string): Promise<ModelWarning[]> {
  try {
    const parsed = ModelWarningsFileSchema.safeParse(JSON.parse(await readFile(modelWarningsPath(dataRoot), "utf8")));
    return parsed.success ? parsed.data.warnings : [];
  } catch {
    return [];
  }
}

/** Adds warnings, replacing an earlier one with the same scope and code. */
export async function appendModelWarnings(dataRoot: string, warnings: ReadonlyArray<Omit<ModelWarning, "at">>, now = new Date()): Promise<void> {
  if (warnings.length === 0) return;
  const at = now.toISOString();
  const incoming = warnings.map((warning) => ({ ...warning, at }));
  const keyOf = (warning: Pick<ModelWarning, "scope" | "code">) => `${warning.scope}\0${warning.code}`;
  const replaced = new Set(incoming.map(keyOf));
  const kept = (await readModelWarnings(dataRoot)).filter((warning) => !replaced.has(keyOf(warning)));
  await atomicWriteJson(modelWarningsPath(dataRoot), { warnings: [...kept, ...incoming].slice(-MAX_WARNINGS) });
}

/** Drops every warning for a scope (the owner picked a model for it). */
export async function clearModelWarnings(dataRoot: string, scope: string): Promise<void> {
  const current = await readModelWarnings(dataRoot);
  const kept = current.filter((warning) => warning.scope !== scope);
  if (kept.length !== current.length) await atomicWriteJson(modelWarningsPath(dataRoot), { warnings: kept });
}
