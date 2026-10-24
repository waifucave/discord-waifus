import { z } from "zod";

// B17: `.unwrap().optional()` only strips a sub-schema's outer default — zod still fills the
// inner field defaults, so `{availability:{sleep:{enabled:true}}}` used to wipe busy intervals.
// Nested settings objects in write bodies are therefore declared through this deep partial without
// defaults (and without refinements: the merged record is re-validated by the full schema when it is
// stored), then deep-merged into stored state. Arrays and non-object leaves replace wholesale.
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends Record<string, unknown>
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export function partialWithoutDefaults<T extends z.ZodType>(schema: T): z.ZodType<DeepPartial<z.output<T>>> {
  let inner: z.ZodType = schema;
  while (inner instanceof z.ZodDefault || inner instanceof z.ZodOptional) {
    inner = inner.unwrap() as z.ZodType;
  }
  if (!(inner instanceof z.ZodObject)) return inner as never;
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(inner.shape as Record<string, z.ZodType>)) {
    shape[key] = partialWithoutDefaults(field).optional();
  }
  return z.object(shape) as never;
}
