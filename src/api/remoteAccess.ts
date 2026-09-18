import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ActivationOperationIdSchema,
  ApprovePairingInputV1Schema,
  CreateInvitationInputV1Schema,
  PairInvitationV1Schema,
  PendingPairingRequestListV1Schema,
  RenameTrustedDeviceInputV1Schema,
  ResetRemoteAccessInputV1Schema,
  RevokeTrustedDeviceInputV1Schema,
  TrustedDeviceListV1Schema,
  TrustedDeviceSummaryV1Schema,
  UpdateRemoteAccessInputV1Schema
} from "../shared/schemas/remoteLifecycle.js";
import { Base64Url16BytesSchema, DeviceIdSchema } from "../shared/schemas/remoteProtocol.js";
import {
  ActivationOperationCapacityError,
  ActivationOperationNotFoundError,
  ActivationRequiredError,
  RemoteAccessActorUnauthorizedError,
  RemoteAccessDeviceRevisionConflictError,
  RemoteAccessEnableBlockedError,
  RemoteAccessRevisionConflictError,
  RemoteAccessInactiveError,
  RemoteAccessService,
  RemoteAccessServiceUnavailableError,
  RemoteAccessTrustedDeviceNotFoundError,
  type ConfirmedAdminActor,
  type LocalActivationActor,
  type RemoteAccessRequestActor
} from "../backend/remoteAccess/remoteAccessService.js";
import {
  IdentityResetSiblingDaemonRunningError,
  IdentityResetStateError
} from "../backend/remoteAccess/identityResetState.js";
import { RemoteAccessTrustConflictError } from "../backend/remoteAccess/stateStore.js";
import {
  DashboardBuild,
  DashboardBuildError
} from "../backend/remoteAccess/dashboardBuild.js";
import {
  HelperCommandError,
  HelperIdentityResetError,
  HelperPairingApprovalRequestBindingSchema,
  HelperSupervisorError
} from "../remote/helperTypes.js";
import {
  OperationAcceptedV1Schema,
  createOperationStatusUrl
} from "../shared/schemas/adminOperations.js";
import { activationRequired, ApiError, conflict, notFound } from "./errors.js";
import {
  afterInternalResponseDrained,
  getInternalDispatchContext
} from "./internalDispatch.js";
import { canonicalMutationBodyBytes } from "./mutations.js";

const ActivationParamsSchema = z.object({
  activationOperationId: ActivationOperationIdSchema
}).strict();

const DashboardAssetParamsSchema = z.object({
  buildId: z.string(),
  "*": z.string()
}).strict();

const InvitationParamsSchema = z.object({
  invitationId: Base64Url16BytesSchema
}).strict();

const PairingRequestParamsSchema = z.object({
  requestId: Base64Url16BytesSchema
}).strict();

const TrustedDeviceParamsSchema = z.object({
  deviceId: DeviceIdSchema
}).strict();

function localBrowserActor(request: FastifyRequest): LocalActivationActor {
  const context = request.principal.kind === "local"
    ? request.principal.browserContext
    : undefined;
  if (!context) {
    throw new ApiError(
      403,
      "A bound local browser session is required.",
      undefined,
      "LocalBrowserRequired"
    );
  }
  if (request.method !== "GET" && !context.csrfValidated) {
    throw new ApiError(403, "CSRF validation is required.", undefined, "CsrfInvalid");
  }
  return {
    hostServerLaunchId: context.hostServerLaunchId,
    browserSessionId: context.browserSessionId
  };
}

function requestActor(request: FastifyRequest): RemoteAccessRequestActor {
  const principal = request.principal;
  return principal.kind === "local"
    ? { kind: "local", stableId: "local" }
    : {
        kind: "remote_device",
        stableId: principal.stableId,
        deviceId: principal.deviceId,
        trustEpoch: principal.trustEpoch
      };
}

function confirmedAdminActor(request: FastifyRequest): ConfirmedAdminActor {
  const principal = request.principal;
  if (!principal.browserContext) {
    throw new ApiError(
      403,
      "A helper-verified browser session is required for this administrative action.",
      undefined,
      "ConfirmedBrowserRequired"
    );
  }
  if (!principal.browserContext.csrfValidated) {
    throw new ApiError(403, "CSRF validation is required.", undefined, "CsrfInvalid");
  }
  if (principal.kind === "local") {
    return {
      kind: "local",
      stableId: "local",
      hostServerLaunchId: principal.browserContext.hostServerLaunchId,
      browserSessionId: principal.browserContext.browserSessionId
    };
  }
  return {
    kind: "remote_device",
    stableId: principal.stableId,
    deviceId: principal.deviceId,
    trustEpoch: principal.trustEpoch,
    gatewayLaunchId: principal.browserContext.gatewayLaunchId,
    browserSessionId: principal.browserContext.browserSessionId
  };
}

function pairingApprovalRequestBinding(
  request: FastifyRequest,
  input: unknown
) {
  const context = request.principal.browserContext;
  if (!context) {
    throw new ApiError(
      403,
      "A helper-verified browser session is required for this administrative action.",
      undefined,
      "ConfirmedBrowserRequired"
    );
  }
  const delegation = getInternalDispatchContext()?.delegation;
  return HelperPairingApprovalRequestBindingSchema.parse({
    confirmationRequestNonce: context.requestNonce,
    confirmationMethod: context.method,
    confirmationTarget: context.canonicalTarget,
    ...(delegation
      ? {
          assistantProvenance: {
            ...delegation,
            confirmedActionPayloadHash: createHash("sha256")
              .update(canonicalMutationBodyBytes(input))
              .digest("base64url")
          }
        }
      : {})
  });
}

function requiredService(service: RemoteAccessService | undefined): RemoteAccessService {
  if (!service) {
    throw new ApiError(
      503,
      "Remote-access management is unavailable.",
      undefined,
      "RemoteAccessUnavailable"
    );
  }
  return service;
}

function activationApiError(error: unknown): never {
  if (error instanceof ActivationRequiredError) throw activationRequired(error.message);
  if (error instanceof ActivationOperationNotFoundError) {
    throw notFound("Activation operation was not found.");
  }
  if (error instanceof ActivationOperationCapacityError) {
    throw new ApiError(503, error.message, undefined, "ActivationCapacity");
  }
  if (error instanceof RemoteAccessRevisionConflictError) {
    throw conflict(error.message, { latest: error.latest });
  }
  if (error instanceof RemoteAccessDeviceRevisionConflictError) {
    throw conflict(error.message, { latest: error.latest });
  }
  if (error instanceof RemoteAccessTrustedDeviceNotFoundError) {
    throw notFound(error.message);
  }
  if (error instanceof RemoteAccessTrustConflictError) {
    throw conflict(error.message);
  }
  if (error instanceof RemoteAccessEnableBlockedError) {
    throw new ApiError(
      409,
      error.message,
      undefined,
      error.code === "bind_not_loopback"
        ? "BindNotLoopback"
        : "CustomDashboardUnsupported"
    );
  }
  if (error instanceof RemoteAccessInactiveError) {
    throw conflict(error.message);
  }
  if (error instanceof RemoteAccessActorUnauthorizedError) {
    throw new ApiError(403, error.message, undefined, "RemotePrincipalUnauthorized");
  }
  if (error instanceof RemoteAccessServiceUnavailableError) {
    throw new ApiError(503, error.message, undefined, "RemoteAccessUnavailable");
  }
  if (
    error instanceof IdentityResetSiblingDaemonRunningError
    || (error instanceof HelperIdentityResetError && error.code === "sibling_daemon_running")
  ) {
    throw new ApiError(
      409,
      "A remote gateway for this data root is still running.",
      undefined,
      "SiblingDaemonRunning"
    );
  }
  if (error instanceof IdentityResetStateError || error instanceof HelperIdentityResetError) {
    throw new ApiError(
      503,
      "Identity reset could not be completed safely.",
      undefined,
      "IdentityResetUnavailable"
    );
  }
  if (error instanceof HelperCommandError) {
    const code = error.code === "worker_quota_exhausted"
      ? "WorkerQuotaExhausted"
      : error.code === "certificate_invalid"
        ? "CertificateInvalid"
        : error.code === "activation_rejected"
          ? "ActivationRejected"
          : "ActivationUnavailable";
    throw new ApiError(503, "Activation helper operation failed.", undefined, code);
  }
  if (error instanceof HelperSupervisorError) {
    throw new ApiError(503, "Activation helper is unavailable.", undefined, "HelperUnavailable");
  }
  throw error;
}

function acceptedOperation(request: FastifyRequest) {
  const operationId = request.mutationContext?.operationId;
  if (!operationId) {
    throw new ApiError(
      503,
      "Administrative operation tracking is unavailable.",
      undefined,
      "OperationUnavailable"
    );
  }
  return OperationAcceptedV1Schema.parse({
    operationId,
    status: "accepted",
    statusUrl: createOperationStatusUrl(operationId)
  });
}

function requiredDashboardBuild(build: DashboardBuild | undefined): DashboardBuild {
  if (!build) {
    throw new ApiError(
      503,
      "The bundled remote dashboard is unavailable.",
      undefined,
      "RemoteDashboardUnavailable"
    );
  }
  return build;
}

function dashboardApiError(error: unknown): never {
  if (error instanceof DashboardBuildError) {
    if (error.code === "dashboard_asset_not_found") {
      throw notFound("The dashboard asset was not found in the current build.");
    }
    if (error.code === "dashboard_asset_cancelled") throw error;
    throw new ApiError(
      503,
      "The pinned remote dashboard build is no longer available.",
      undefined,
      error.code === "dashboard_build_changed"
        ? "RemoteDashboardChanged"
        : "RemoteDashboardUnavailable"
    );
  }
  throw error;
}

async function waitForResponseDrain(reply: FastifyReply): Promise<boolean> {
  if (reply.raw.destroyed || reply.raw.writableEnded) return false;
  return new Promise<boolean>((resolve) => {
    const cleanup = () => {
      reply.raw.removeListener("drain", drained);
      reply.raw.removeListener("close", closed);
      reply.raw.removeListener("error", closed);
    };
    const drained = () => {
      cleanup();
      resolve(true);
    };
    const closed = () => {
      cleanup();
      resolve(false);
    };
    reply.raw.once("drain", drained);
    reply.raw.once("close", closed);
    reply.raw.once("error", closed);
  });
}

export function registerRemoteAccessRoutes(
  app: FastifyInstance,
  service?: RemoteAccessService,
  dashboardBuild?: DashboardBuild
): void {
  app.get("/api/remote-access", async () => {
    try {
      return await requiredService(service).getStatus();
    } catch (error) {
      return activationApiError(error);
    }
  });

  app.post("/api/remote-access/activation", async (request, reply) => {
    try {
      const result = await requiredService(service).beginActivation(localBrowserActor(request));
      return reply.status(201).send(result);
    } catch (error) {
      return activationApiError(error);
    }
  });

  app.get("/api/remote-access/activation/:activationOperationId", async (request) => {
    try {
      const params = ActivationParamsSchema.parse(request.params);
      return await requiredService(service).getActivation(
        params.activationOperationId,
        localBrowserActor(request)
      );
    } catch (error) {
      return activationApiError(error);
    }
  });

  app.delete("/api/remote-access/activation/:activationOperationId", async (request, reply) => {
    try {
      const params = ActivationParamsSchema.parse(request.params);
      await requiredService(service).cancelActivation(
        params.activationOperationId,
        localBrowserActor(request)
      );
      return reply.status(204).send();
    } catch (error) {
      return activationApiError(error);
    }
  });

  app.put("/api/remote-access", async (request, reply) => {
    try {
      const input = UpdateRemoteAccessInputV1Schema.parse(request.body);
      const config = await requiredService(service).updateConfig(input);
      if (input.enabled === undefined) return config;
      if (input.enabled === false) {
        reply.raw.once("finish", () => {
          void requiredService(service).drainDisabledHelper();
        });
      }
      return reply.status(202).send(acceptedOperation(request));
    } catch (error) {
      return activationApiError(error);
    }
  });

  app.route({
    method: "POST",
    url: "/api/remote-access/reset",
    preValidation: async (request) => {
      try {
        localBrowserActor(request);
        ResetRemoteAccessInputV1Schema.parse(request.body);
        await requiredService(service).assertNoLiveRemoteSibling();
      } catch (error) {
        return activationApiError(error);
      }
    },
    handler: async (request, reply) => {
      try {
        localBrowserActor(request);
        ResetRemoteAccessInputV1Schema.parse(request.body);
        await requiredService(service).resetIdentity();
        return reply.status(202).send(acceptedOperation(request));
      } catch (error) {
        return activationApiError(error);
      }
    }
  });

  app.post("/api/remote-access/invitations", async (request, reply) => {
    try {
      CreateInvitationInputV1Schema.parse(request.body);
      const mutation = request.mutationContext;
      if (!mutation) {
        throw new ApiError(
          503,
          "Administrative operation tracking is unavailable.",
          undefined,
          "OperationUnavailable"
        );
      }
      const invitation = await requiredService(service).createInvitation(
        confirmedAdminActor(request),
        mutation.idempotencyKey
      );
      const body = JSON.stringify(PairInvitationV1Schema.parse(invitation));
      return reply
        .status(201)
        .header("content-type", "application/json; charset=utf-8")
        .header("cache-control", "no-store")
        // Pair tokens are intentionally visible only in this confirmed, no-store browser
        // response. Sending pre-serialized JSON prevents the global log/transcript redactor from
        // replacing the one-time token before the secure invitation card can render it.
        .send(body);
    } catch (error) {
      return activationApiError(error);
    }
  });

  app.delete("/api/remote-access/invitations/:invitationId", async (request, reply) => {
    try {
      const params = InvitationParamsSchema.parse(request.params);
      await requiredService(service).cancelInvitation(
        params.invitationId,
        confirmedAdminActor(request)
      );
      return reply.status(202).send(acceptedOperation(request));
    } catch (error) {
      return activationApiError(error);
    }
  });

  app.get("/api/remote-access/pairing-requests", async (request) => {
    try {
      const result = await requiredService(service).listPairingRequests(requestActor(request));
      return PendingPairingRequestListV1Schema.parse(result);
    } catch (error) {
      return activationApiError(error);
    }
  });

  app.post("/api/remote-access/pairing-requests/:requestId/approve", async (request, reply) => {
    try {
      const params = PairingRequestParamsSchema.parse(request.params);
      const input = ApprovePairingInputV1Schema.parse(request.body);
      await requiredService(service).approvePairingRequest(
        params.requestId,
        input,
        confirmedAdminActor(request),
        pairingApprovalRequestBinding(request, input)
      );
      return reply.status(202).send(acceptedOperation(request));
    } catch (error) {
      return activationApiError(error);
    }
  });

  app.post("/api/remote-access/pairing-requests/:requestId/reject", async (request, reply) => {
    try {
      const params = PairingRequestParamsSchema.parse(request.params);
      await requiredService(service).rejectPairingRequest(params.requestId, requestActor(request));
      return reply.status(202).send(acceptedOperation(request));
    } catch (error) {
      return activationApiError(error);
    }
  });

  app.get("/api/remote-access/devices", async () => {
    try {
      return TrustedDeviceListV1Schema.parse(await requiredService(service).listDevices());
    } catch (error) {
      return activationApiError(error);
    }
  });

  app.put("/api/remote-access/devices/:deviceId", async (request) => {
    try {
      const params = TrustedDeviceParamsSchema.parse(request.params);
      const input = RenameTrustedDeviceInputV1Schema.parse(request.body);
      const device = await requiredService(service).renameDevice(
        params.deviceId,
        input,
        requestActor(request)
      );
      return TrustedDeviceSummaryV1Schema.parse(device);
    } catch (error) {
      return activationApiError(error);
    }
  });

  app.delete("/api/remote-access/devices/:deviceId", async (request, reply) => {
    try {
      const params = TrustedDeviceParamsSchema.parse(request.params);
      const input = RevokeTrustedDeviceInputV1Schema.parse(request.body);
      const remoteAccess = requiredService(service);
      const revocation = await remoteAccess.revokeDevice(
        params.deviceId,
        input,
        confirmedAdminActor(request)
      );
      const finish = () => {
        void remoteAccess.finishDeviceRevocation(revocation).catch(() => undefined);
      };
      if (!afterInternalResponseDrained(finish)) reply.raw.once("finish", finish);
      return reply.status(202).send(acceptedOperation(request));
    } catch (error) {
      return activationApiError(error);
    }
  });

  app.post("/api/remote-access/reconnect", async (request, reply) => {
    try {
      await requiredService(service).reconnect();
      return reply.status(202).send(acceptedOperation(request));
    } catch (error) {
      return activationApiError(error);
    }
  });

  app.get("/api/remote-access/diagnostics", async () => {
    try {
      return await requiredService(service).diagnostics();
    } catch (error) {
      return activationApiError(error);
    }
  });

  app.get("/api/remote-access/dashboard-manifest", async (_request, reply) => {
    try {
      const current = await requiredDashboardBuild(dashboardBuild).readManifest();
      return reply
        .header("content-type", "application/json; charset=utf-8")
        .header("content-length", current.bytes.byteLength)
        .send(current.bytes);
    } catch (error) {
      return dashboardApiError(error);
    }
  });

  app.get("/api/remote-access/dashboard-assets/:buildId/*", async (request, reply) => {
    try {
      const params = DashboardAssetParamsSchema.parse(request.params);
      const opened = await requiredDashboardBuild(dashboardBuild).openAsset(
        params.buildId,
        params["*"],
        getInternalDispatchContext()?.signal
      );
      const immutable = opened.asset.path !== "index.html";
      reply.raw.writeHead(200, {
        "content-type": opened.asset.contentType,
        "content-length": opened.asset.byteSize,
        "cache-control": immutable
          ? "public, max-age=31536000, immutable"
          : "no-store",
        "x-content-type-options": "nosniff",
        ...(immutable ? { etag: `"${opened.asset.sha256}"` } : {})
      });
      try {
        if (request.method !== "HEAD") {
          for await (const chunk of opened.stream) {
            if (reply.raw.destroyed || reply.raw.writableEnded) break;
            if (!reply.raw.write(chunk) && !await waitForResponseDrain(reply)) break;
          }
        } else {
          opened.stream.destroy();
        }
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
      } catch {
        if (!reply.raw.destroyed) reply.raw.destroy();
      }
      return reply;
    } catch (error) {
      return dashboardApiError(error);
    }
  });
}
