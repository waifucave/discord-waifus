import { pendingMigrationStep } from "./pending.js";

// Step `waifu-params-gateway-040-v1` (spec 8.10). Pending: owned by T7a, which replaces this stub with the real
// body and removes `pending: true` from its registration in ../migrations.ts.
export const migrateWaifuParamsGateway040 = pendingMigrationStep("waifu-params-gateway-040-v1");
