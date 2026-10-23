import { pendingMigrationStep } from "./pending.js";

// Step `pending-observations-global-v1` (spec 8.2). Pending: owned by T6, which replaces this stub with the real
// body and removes `pending: true` from its registration in ../migrations.ts.
export const migratePendingObservationsGlobal = pendingMigrationStep("pending-observations-global-v1");
