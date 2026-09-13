import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ActivationOperationIdSchema,
  UpdateRemoteAccessInputV1Schema
} from "../shared/schemas/remoteLifecycle.js";
import {
  ActivationOperationCapacityError,
  ActivationOperationNotFoundError,
  ActivationRequiredError,
  RemoteAccessEnableBlockedError,
  RemoteAccessRevisionConflictError,
  RemoteAccessInactiveError,
  RemoteAccessService,
  RemoteAccessServiceUnavailableError,
  type LocalActivationActor
} from "../backend/remoteAccess/remoteAccessService.js";
import {
  DashboardBuild,
  DashboardBuildError
} from "../backend/remoteAccess/dashboardBuild.js";
import { HelperCommandError, HelperSupervisorError } from "../remote/helperTypes.js";
import {
  OperationAcceptedV1Schema,
  createOperationStatusUrl
} from "../shared/schemas/adminOperations.js";
import { activationRequired, ApiError, conflict, notFound } from "./errors.js";
import { getInternalDispatchContext } from "./internalDispatch.js";

const ActivationParamsSchema = z.object({
  activationOperationId: ActivationOperationIdSchema
}).strict();

const DashboardAssetParamsSchema = z.object({
  buildId: z.string(),
  "*": z.string()
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
  if (error instanceof RemoteAccessServiceUnavailableError) {
    throw new ApiError(503, error.message, undefined, "RemoteAccessUnavailable");
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
