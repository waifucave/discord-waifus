// Placeholder body for a migration step whose owning work has not landed yet (spec 8.0/8.2).
// The step is registered in migrations.ts with `pending: true`, which makes runMigrations skip it
// without recording it in the ledger; if it is ever invoked anyway this throws so a missing
// implementation can never be mistaken for a successful no-op. The owning task replaces the stub
// with the real body and drops the `pending` flag in the same change.
export function pendingMigrationStep(id: string): (dataRoot: string) => Promise<string | undefined> {
  return async () => {
    throw new Error(`Migration step ${id} is pending and has no implementation yet.`);
  };
}
