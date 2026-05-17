import { z } from "zod";

export const CURRENT_SCHEMA_VERSION = 1;

export const IsoDateStringSchema = z.string().datetime({ offset: true });

export const RevisionedRecordSchema = z.object({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
  revision: z.number().int().nonnegative(),
  updatedAt: IsoDateStringSchema
});

export const EmptyRevisionedRecordSchema = RevisionedRecordSchema.extend({});

export type RevisionedRecord = z.infer<typeof RevisionedRecordSchema>;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export function nowIso(): string {
  return new Date().toISOString();
}

export function createRevisionedBase(): RevisionedRecord {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    revision: 0,
    updatedAt: nowIso()
  };
}

export function bumpRevision<T extends RevisionedRecord>(record: T, now = nowIso()): T {
  return {
    ...record,
    revision: record.revision + 1,
    updatedAt: now
  };
}
