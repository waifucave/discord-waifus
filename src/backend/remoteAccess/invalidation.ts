import { z } from "zod";
import {
  DeviceIdSchema,
  PrincipalStableIdSchema,
  Uint64DecimalSchema
} from "../../shared/schemas/remoteProtocol.js";

export const RemoteAccessInvalidationV1Schema = z.object({
  version: z.literal(1),
  kind: z.literal("device_trust_revoked"),
  stableId: PrincipalStableIdSchema,
  deviceId: DeviceIdSchema,
  trustEpoch: Uint64DecimalSchema,
  denyEpoch: Uint64DecimalSchema
}).strict().superRefine((value, ctx) => {
  if (value.stableId !== `remote:${value.deviceId}`) {
    ctx.addIssue({
      code: "custom",
      path: ["stableId"],
      message: "A device invalidation stable ID must derive from its device ID."
    });
  }
  if (BigInt(value.denyEpoch) <= BigInt(value.trustEpoch)) {
    ctx.addIssue({
      code: "custom",
      path: ["denyEpoch"],
      message: "A device invalidation deny epoch must advance beyond its trust epoch."
    });
  }
});

export type RemoteAccessInvalidationV1 = z.infer<
  typeof RemoteAccessInvalidationV1Schema
>;
export type RemoteAccessInvalidationListener = (
  event: RemoteAccessInvalidationV1
) => void;

export class RemoteAccessInvalidations {
  readonly #listeners = new Set<RemoteAccessInvalidationListener>();

  subscribe(listener: RemoteAccessInvalidationListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(value: RemoteAccessInvalidationV1): void {
    const event = Object.freeze(RemoteAccessInvalidationV1Schema.parse(value));
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // Invalidation is a security fan-out. One feature subscriber must never prevent bridge
        // cancellation or another subscriber from dropping state owned by the revoked epoch.
      }
    }
  }

  clear(): void {
    this.#listeners.clear();
  }
}
