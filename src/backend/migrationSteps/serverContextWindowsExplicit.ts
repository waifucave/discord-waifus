import { pendingMigrationStep } from "./pending.js";

// Step `server-context-windows-explicit-v1` (spec 8.7). Pending: owned by T5, which replaces this stub with the real
// body and removes `pending: true` from its registration in ../migrations.ts.
export const migrateServerContextWindowsExplicit = pendingMigrationStep("server-context-windows-explicit-v1");
