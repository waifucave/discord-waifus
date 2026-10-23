import { pendingMigrationStep } from "./pending.js";

// Step `memories-global-origin-subjects-v1` (spec 8.8). Pending: owned by T6, which replaces this stub with the real
// body and removes `pending: true` from its registration in ../migrations.ts.
export const migrateMemoriesGlobalOriginSubjects = pendingMigrationStep("memories-global-origin-subjects-v1");
