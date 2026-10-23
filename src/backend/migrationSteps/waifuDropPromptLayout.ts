import { pendingMigrationStep } from "./pending.js";

// Step `waifu-drop-prompt-layout-v1` (spec 8.6). Pending: owned by T4, which replaces this stub with the real
// body and removes `pending: true` from its registration in ../migrations.ts.
export const migrateWaifuDropPromptLayout = pendingMigrationStep("waifu-drop-prompt-layout-v1");
