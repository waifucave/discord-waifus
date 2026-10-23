import { pendingMigrationStep } from "./pending.js";

// Step `dream-cursor-global-v1` (spec 8.2). Pending: owned by T6, which replaces this stub with the real
// body and removes `pending: true` from its registration in ../migrations.ts.
export const migrateDreamCursorGlobal = pendingMigrationStep("dream-cursor-global-v1");
