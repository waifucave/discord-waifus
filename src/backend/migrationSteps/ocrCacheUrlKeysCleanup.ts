import { pendingMigrationStep } from "./pending.js";

// Step `ocr-cache-url-keys-cleanup-v1` (spec 8.4). Pending: owned by T2, which replaces this stub with the real
// body and removes `pending: true` from its registration in ../migrations.ts.
export const migrateOcrCacheUrlKeysCleanup = pendingMigrationStep("ocr-cache-url-keys-cleanup-v1");
