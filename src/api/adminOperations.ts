import type { FastifyInstance } from "fastify";
import {
  AuditActorV1Schema,
  OperationIdSchema,
  type AuditActorV1
} from "../shared/schemas/adminOperations.js";
import type { OperationStore } from "../storage/operationStore.js";
import { notFound } from "./errors.js";
import type { RequestPrincipal } from "./requestPrincipal.js";

export function auditActorFromPrincipal(principal: RequestPrincipal): AuditActorV1 {
  return AuditActorV1Schema.parse(principal.kind === "local"
    ? { kind: "local", stableId: "local" }
    : {
        kind: "remote_device",
        stableId: principal.stableId,
        deviceId: principal.deviceId,
        trustEpoch: principal.trustEpoch
      });
}

export function registerAdminOperationRoutes(
  app: FastifyInstance,
  operationStore: OperationStore
): void {
  app.get("/api/admin/operations/:operationId", async (request) => {
    const rawId = (request.params as { operationId?: unknown }).operationId;
    const operationId = OperationIdSchema.safeParse(rawId);
    const status = operationId.success
      ? await operationStore.getVisible(
          operationId.data,
          auditActorFromPrincipal(request.principal)
        )
      : undefined;
    if (!status) throw notFound("Operation was not found.");
    return status;
  });
}
