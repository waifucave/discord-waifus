import { pendingMigrationStep } from "./pending.js";

// Step `memories-cross-guild-dedupe-v1` (spec 8.8). Pending: owned by T6, which replaces this stub with the real
// body and removes `pending: true` from its registration in ../migrations.ts.
export const migrateMemoriesCrossGuildDedupe = pendingMigrationStep("memories-cross-guild-dedupe-v1");
