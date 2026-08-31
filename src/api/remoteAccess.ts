import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ActivationOperationIdSchema,
  UpdateRemoteAccessInputV1Schema
} from "../shared/schemas/remoteLifecycle.js";
import {
  ActivationOperationCapacityError,
  ActivationOperationNotFoundError,
  ActivationRequiredError,
  RemoteAccessRevisionConflictError,
  RemoteAccessService,
  RemoteAccessServiceUnavailableError,
  type LocalActivationActor
} from "../backend/remoteAccess/remoteAccessService.js";
import { HelperCommandError, HelperSupervisorError } from "../remote/helperTypes.js";
import { activationRequired, ApiError, conflict, notFound } from "./errors.js";

const ActivationParamsSchema = z.object({
  activationOperationId: ActivationOperationIdSchema
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

export function registerRemoteAccessRoutes(
  app: FastifyInstance,
  service?: RemoteAccessService
): void {
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

  app.put("/api/remote-access", async (request) => {
    try {
      const input = UpdateRemoteAccessInputV1Schema.parse(request.body);
      return await requiredService(service).updateConfig(input);
    } catch (error) {
      return activationApiError(error);
    }
  });
}
