import { z } from "zod";
import {
  Base64Url16BytesSchema,
  Base64Url32BytesSchema,
  CanonicalTargetSchema,
  HttpMethodSchema,
  RemoteBrowserContextV1Schema,
  RequestPrincipalWireSchema,
  type RemoteBrowserContextV1,
  type RequestPrincipalWire
} from "../shared/schemas/remoteProtocol.js";

export const LocalBrowserContextSchema = z.object({
  verifiedBy: z.literal("host_server"),
  hostServerLaunchId: Base64Url32BytesSchema,
  browserSessionId: Base64Url32BytesSchema,
  requestNonce: Base64Url16BytesSchema,
  method: HttpMethodSchema,
  canonicalTarget: CanonicalTargetSchema,
  csrfValidated: z.boolean()
}).strict();

export type LocalBrowserContext = z.infer<typeof LocalBrowserContextSchema>;
export type RemoteBrowserContext = RemoteBrowserContextV1 & {
  readonly verifiedBy: "host_helper";
};

export type LocalRequestPrincipal = {
  readonly kind: "local";
  readonly stableId: "local";
  readonly browserContext?: LocalBrowserContext;
};

export type RemoteRequestPrincipal = Omit<RequestPrincipalWire, "browserContext"> & {
  readonly browserContext?: RemoteBrowserContext;
};

export type RequestPrincipal = LocalRequestPrincipal | RemoteRequestPrincipal;

const DELEGATION_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const AssistantDelegationSchema = z.object({
  conversationId: z.string().min(1).max(128).regex(DELEGATION_IDENTIFIER_PATTERN),
  toolCallId: z.string().min(1).max(128).regex(DELEGATION_IDENTIFIER_PATTERN).optional(),
  pendingActionId: z.string().min(1).max(128).regex(DELEGATION_IDENTIFIER_PATTERN).optional()
}).strict();

export type AssistantDelegation = z.infer<typeof AssistantDelegationSchema>;

function freeze<T extends object>(value: T): Readonly<T> {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object" && !Object.isFrozen(nested)) {
      freeze(nested as object);
    }
  }
  return Object.freeze(value);
}

export function createLocalRequestPrincipal(
  browserContext?: LocalBrowserContext
): LocalRequestPrincipal {
  const parsedContext = browserContext === undefined
    ? undefined
    : LocalBrowserContextSchema.parse(browserContext);
  return freeze({
    kind: "local" as const,
    stableId: "local" as const,
    ...(parsedContext ? { browserContext: parsedContext } : {})
  });
}

export const LOCAL_REQUEST_PRINCIPAL = createLocalRequestPrincipal();

export function createRemoteRequestPrincipal(value: unknown): RemoteRequestPrincipal {
  const candidate = value as { browserContext?: unknown };
  const suppliedContext = candidate?.browserContext as { verifiedBy?: unknown } | undefined;
  if (suppliedContext?.verifiedBy !== undefined && suppliedContext.verifiedBy !== "host_helper") {
    throw new TypeError("Remote browser context has invalid verifier provenance.");
  }
  const wire = RequestPrincipalWireSchema.parse({
    ...(value as Record<string, unknown>),
    ...(suppliedContext
      ? {
          browserContext: Object.fromEntries(
            Object.entries(suppliedContext).filter(([key]) => key !== "verifiedBy")
          )
        }
      : {})
  });
  const { browserContext, ...principalFields } = wire;
  return freeze({
    ...principalFields,
    ...(browserContext
      ? { browserContext: { ...browserContext, verifiedBy: "host_helper" as const } }
      : {})
  });
}

export function parseRequestPrincipal(value: unknown): RequestPrincipal {
  if ((value as { kind?: unknown } | undefined)?.kind === "local") {
    const candidate = value as { stableId?: unknown; browserContext?: unknown };
    if (candidate.stableId !== "local") {
      throw new TypeError("Local principal stable ID must be local.");
    }
    return createLocalRequestPrincipal(
      candidate.browserContext === undefined
        ? undefined
        : LocalBrowserContextSchema.parse(candidate.browserContext)
    );
  }
  return createRemoteRequestPrincipal(value);
}

export function parseAssistantDelegation(value: unknown): AssistantDelegation {
  return freeze(AssistantDelegationSchema.parse(value));
}

export function withoutBrowserContext(principal: RequestPrincipal): RequestPrincipal {
  if (principal.browserContext === undefined) return principal;
  if (principal.kind === "local") return LOCAL_REQUEST_PRINCIPAL;
  const { browserContext: _browserContext, ...wire } = principal;
  return createRemoteRequestPrincipal(wire);
}

export function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%", 1)[0];
  if (normalized === "::1") return true;
  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  const octets = ipv4.split(".");
  return octets.length === 4
    && octets.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
    && Number(octets[0]) === 127;
}

export function remoteBrowserContextWire(
  context: RemoteBrowserContext
): RemoteBrowserContextV1 {
  const { verifiedBy: _verifiedBy, ...wire } = context;
  return RemoteBrowserContextV1Schema.parse(wire);
}
