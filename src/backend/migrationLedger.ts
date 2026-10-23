import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicWriteJson } from "../storage/atomic.js";

// Persisted record of which boot migration steps already ran on this data root
// (`app/migrations.json`). It only ever saves work: a missing, corrupt, or untrusted ledger makes
// runMigrations re-run every step, which is safe because each step is idempotent.
export const MIGRATION_LEDGER_RELATIVE_PATH = path.join("app", "migrations.json");

const MigrationLedgerSchema = z.object({
  ledgerVersion: z.literal(1),
  // App version that last wrote the ledger.
  appVersion: z.string().min(1),
  updatedAt: z.string(),
  steps: z.record(
    z.string().min(1),
    z.object({
      appliedAt: z.string(),
      // App version that ran the step (once-per-app-version steps re-run when it differs).
      appVersion: z.string().min(1)
    })
  )
});

export type MigrationLedger = z.infer<typeof MigrationLedgerSchema>;

export function emptyMigrationLedger(appVersion: string): MigrationLedger {
  return { ledgerVersion: 1, appVersion, updatedAt: new Date().toISOString(), steps: {} };
}

async function readJsonLeniently(filePath: string): Promise<unknown | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// Returns the ledger to trust, or undefined when every step must run again:
// - no ledger yet (fresh root, or an install that predates the ledger);
// - the ledger is unreadable JSON or has an unknown shape;
// - the last host that ran on this root (`app/runtime.json` packageVersion) is not the version
//   that last wrote the ledger. That means a ledger-unaware (older) build ran here in between and
//   may have written legacy shapes the recorded steps would no longer convert.
export async function readTrustedMigrationLedger(dataRoot: string): Promise<MigrationLedger | undefined> {
  const raw = await readJsonLeniently(path.join(dataRoot, MIGRATION_LEDGER_RELATIVE_PATH));
  const parsed = MigrationLedgerSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const runtime = await readJsonLeniently(path.join(dataRoot, "app", "runtime.json"));
  const lastHostVersion =
    typeof runtime === "object" && runtime !== null && !Array.isArray(runtime)
      ? (runtime as Record<string, unknown>).packageVersion
      : undefined;
  if (typeof lastHostVersion === "string" && lastHostVersion !== parsed.data.appVersion) {
    return undefined;
  }
  return parsed.data;
}

export async function writeMigrationLedger(dataRoot: string, ledger: MigrationLedger): Promise<void> {
  await atomicWriteJson(path.join(dataRoot, MIGRATION_LEDGER_RELATIVE_PATH), ledger, { mode: 0o600 });
}
