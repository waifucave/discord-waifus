import { ensureDataLayout } from "../config/layout.js";

export type MigrationResult = {
  applied: string[];
};

export async function runMigrations(dataRoot: string): Promise<MigrationResult> {
  await ensureDataLayout(dataRoot);
  return {
    applied: []
  };
}
