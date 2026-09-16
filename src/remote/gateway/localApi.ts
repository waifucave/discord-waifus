import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ActivationStartResultSchema,
  ActivationOperationIdSchema,
  ActivationStatusSchema,
  ConnectRememberedHostResultV1Schema,
  DisconnectRememberedHostResultV1Schema,
  ForgetRememberedHostInputV1Schema,
  ForgetRememberedHostResultV1Schema,
  GatewayBootstrapV1Schema,
  GatewayLocalEventV1Schema,
  PairOperationIdSchema,
  PairOperationStatusSchema,
  PairStartInputSchema,
  PairStartResultSchema,
  RememberedHostActionInputV1Schema,
  type ActivationStatus,
  type GatewayBootstrapV1,
  type GatewayLocalEventV1,
  type PairOperationStatus,
  type PairStartInput
} from "../../shared/schemas/remoteLifecycle.js";
import {
  Base64Url32BytesSchema,
  UINT64_MAX,
  Uint64DecimalSchema,
  type Uint64Decimal,
  type RemoteBrowserContextV1
} from "../../shared/schemas/remoteProtocol.js";
import type {
  HelperActivationCancel,
  HelperActivationPoll,
  HelperActivationStart
} from "../helperTypes.js";
import {
  RememberedHostStore,
  RememberedHostStoreError,
  type RememberedHostRecordV1
} from "../rememberedHosts.js";
import { RemoteOriginStore } from "./originStore.js";
import {
  SHELL_SECURITY_HEADERS
} from "./security.js";
import type { RemoteGatewayHandlerSecurity } from "./server.js";

const EmptyBodySchema = z.object({}).strict();
const LIVE_PAIR_STATES = new Set([
  "starting",
  "verification_required",
  "awaiting_host_approval",
  "connecting"
]);
const MAX_OPERATION_ID_ATTEMPTS = 8;
const MAX_LOCAL_OPERATIONS = 1_024;
const MAX_EVENT_RECORDS = 256;

export type RemoteGatewayBackendSnapshot = Readonly<{
  gatewayVersion: string;
  helperVersion: string | null;
  helperReleaseSequence: string | null;
  protocol: Readonly<{ major: number; minor: number }>;
  capabilities: readonly string[];
  activationState: "activation_required" | "active" | "renewal_due";
  helperState: "disabled" | "starting" | "ready" | "degraded" | "failed";
  controlState: "inactive" | "connecting" | "connected" | "reconnecting" | "unavailable";
  directState: "inactive" | "direct" | "reconnecting" | "direct_unavailable";
  lastErrorCode: GatewayBootstrapV1["lastErrorCode"];
}>;

export type RemoteGatewayLocalBackend = {
  snapshot: () => RemoteGatewayBackendSnapshot | Promise<RemoteGatewayBackendSnapshot>;
  beginActivation: (operationId: string) => Promise<HelperActivationStart>;
  pollActivation: (operationId: string) => Promise<HelperActivationPoll>;
  cancelActivation: (operationId: string) => Promise<HelperActivationCancel>;
  beginPair: (
    operationId: string,
    input: PairStartInput
  ) => Promise<Readonly<{ expiresAt: string }>>;
  pollPair: (operationId: string) => Promise<PairOperationStatus>;
  cancelPair: (operationId: string) => Promise<void>;
  consumeCompletedPair: (operationId: string) => Promise<RememberedHostRecordV1>;
  connectRememberedHost: (host: RememberedHostRecordV1) => Promise<void>;
  disconnectRememberedHost: (host: RememberedHostRecordV1) => Promise<void>;
  requestSignedSelfRevocation: (host: RememberedHostRecordV1) => Promise<boolean>;
  forgetRememberedHost: (host: RememberedHostRecordV1) => Promise<void>;
};

export type RemoteLocalApiOptions = {
  readonly backend: RemoteGatewayLocalBackend;
  readonly rememberedHosts: RememberedHostStore;
  readonly origins: RemoteOriginStore;
  readonly issueSelectedHostBootstrap?: (host: RememberedHostRecordV1) => Promise<string>;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly shellRoot?: string;
};

type ActivationOperation = {
  readonly ownerSessionId: string;
  readonly expiresAt: string;
  status?: ActivationStatus;
};

type PairOperation = {
  readonly ownerSessionId: string;
  readonly expiresAt: string;
  status: PairOperationStatus;
  completion?: Promise<void>;
};

type LocalEventRecord = {
  readonly cursor: string;
  readonly ownerSessionId: string | null;
  readonly event: GatewayLocalEventV1;
};

type LocalEventSubscriber = {
  readonly ownerSessionId: string;
  readonly send: (record: LocalEventRecord) => void;
};

function exactRandomBytes(
  random: (size: number) => Uint8Array,
  size: number,
  label: string
): Buffer {
  const bytes = Buffer.from(random(size));
  if (bytes.byteLength !== size) throw new TypeError(`${label} must contain exactly ${size} bytes.`);
  return bytes;
}

function seconds(now: () => number): Uint64Decimal {
  return Uint64DecimalSchema.parse(BigInt(Math.floor(now() / 1_000)).toString());
}

function statusUrl(operationId: string): string {
  return `/_waifus_remote/v1/pair/${operationId}`;
}

function browserOwner(context: RemoteBrowserContextV1): string {
  return `${context.gatewayLaunchId}.${context.browserSessionId}`;
}

function localPath(canonicalTarget: string): { pathname: string; hasQuery: boolean } {
  const separator = canonicalTarget.indexOf("?");
  return separator === -1
    ? { pathname: canonicalTarget, hasQuery: false }
    : { pathname: canonicalTarget.slice(0, separator), hasQuery: true };
}

function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  return schema.parse(value ?? {});
}

function eventBytes(record: LocalEventRecord): string {
  return `id: ${record.cursor}\nevent: gateway\ndata: ${JSON.stringify(record.event)}\n\n`;
}

export class RemoteLocalApi {
  readonly #backend: RemoteGatewayLocalBackend;
  readonly #rememberedHosts: RememberedHostStore;
  readonly #origins: RemoteOriginStore;
  readonly #issueSelectedHostBootstrap:
    | ((host: RememberedHostRecordV1) => Promise<string>)
    | undefined;
  readonly #now: () => number;
  readonly #random: (size: number) => Uint8Array;
  readonly #shellRoot: string;
  readonly #activationOperations = new Map<string, ActivationOperation>();
  readonly #pairOperations = new Map<string, PairOperation>();
  readonly #eventEpoch: string;
  readonly #eventRecords: LocalEventRecord[] = [];
  readonly #eventSubscribers = new Set<LocalEventSubscriber>();
  #eventSequence = 0n;

  constructor(options: RemoteLocalApiOptions) {
    this.#backend = options.backend;
    this.#rememberedHosts = options.rememberedHosts;
    this.#origins = options.origins;
    this.#issueSelectedHostBootstrap = options.issueSelectedHostBootstrap;
    this.#now = options.now ?? Date.now;
    this.#random = options.randomBytes ?? cryptoRandomBytes;
    this.#shellRoot = path.resolve(options.shellRoot ?? path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "dist-remote-shell"
    ));
    this.#eventEpoch = exactRandomBytes(this.#random, 16, "Local event epoch").toString("base64url");
  }

  readonly handle = async (
    request: FastifyRequest,
    reply: FastifyReply,
    browserContext: RemoteBrowserContextV1,
    security: RemoteGatewayHandlerSecurity
  ): Promise<unknown> => {
    const target = localPath(browserContext.canonicalTarget);
    if (!target.pathname.startsWith("/_waifus_remote/v1/")) {
      const openMatch = target.pathname.match(
        /^\/_waifus_remote\/open\/([A-Za-z0-9_-]{43})$/u
      );
      if (openMatch && request.method === "GET" && !target.hasQuery) {
        return this.#openSelectedHost(reply, openMatch[1]);
      }
      return this.#shellAsset(request, reply, target);
    }
    reply.header("cache-control", "no-store");
    if (target.hasQuery) {
      return reply.code(400).send({ error: "InvalidRequest" });
    }
    try {
      if (request.method === "GET" && target.pathname === "/_waifus_remote/v1/bootstrap") {
        security.deliverCsrf();
        return await this.#bootstrap(security);
      }
      if (request.method === "POST" && target.pathname === "/_waifus_remote/v1/activation") {
        parseBody(EmptyBodySchema, request.body);
        return reply.code(201).send(await this.#beginActivation(browserOwner(browserContext)));
      }
      const activationMatch = target.pathname.match(
        /^\/_waifus_remote\/v1\/activation\/([A-Za-z0-9_-]{43})$/u
      );
      if (activationMatch && request.method === "GET") {
        const status = await this.#pollActivation(
          browserOwner(browserContext),
          activationMatch[1]
        );
        return status ?? reply.code(404).send({ error: "NotFound" });
      }
      if (activationMatch && request.method === "DELETE") {
        const cancelled = await this.#cancelActivation(
          browserOwner(browserContext),
          activationMatch[1]
        );
        return cancelled
          ? reply.code(204).send()
          : reply.code(404).send({ error: "NotFound" });
      }
      if (request.method === "GET" && target.pathname === "/_waifus_remote/v1/hosts") {
        return await this.#rememberedHosts.list();
      }
      if (request.method === "POST" && target.pathname === "/_waifus_remote/v1/pair") {
        const input = PairStartInputSchema.parse(request.body);
        const started = await this.#beginPair(browserOwner(browserContext), input);
        return reply.code(202).send(started);
      }
      const pairMatch = target.pathname.match(
        /^\/_waifus_remote\/v1\/pair\/([A-Za-z0-9_-]{43})$/u
      );
      if (pairMatch && request.method === "GET") {
        const status = await this.#pollPair(browserOwner(browserContext), pairMatch[1]);
        return status ?? reply.code(404).send({ error: "NotFound" });
      }
      if (pairMatch && request.method === "DELETE") {
        const cancelled = await this.#cancelPair(browserOwner(browserContext), pairMatch[1]);
        return cancelled
          ? reply.code(204).send()
          : reply.code(404).send({ error: "NotFound" });
      }
      const hostMatch = target.pathname.match(
        /^\/_waifus_remote\/v1\/hosts\/([A-Za-z0-9_-]{43})\/(connect|disconnect)$/u
      );
      if (hostMatch && request.method === "POST") {
        parseBody(RememberedHostActionInputV1Schema, request.body);
        return hostMatch[2] === "connect"
          ? reply.code(202).send(await this.#connect(hostMatch[1]))
          : await this.#disconnect(hostMatch[1]);
      }
      const forgetMatch = target.pathname.match(
        /^\/_waifus_remote\/v1\/hosts\/([A-Za-z0-9_-]{43})$/u
      );
      if (forgetMatch && request.method === "DELETE") {
        const input = ForgetRememberedHostInputV1Schema.parse(request.body);
        const result = await this.#forget(forgetMatch[1], input);
        return result.state === "local_only_confirmation_required"
          ? reply.code(409).send(result)
          : result;
      }
      if (request.method === "GET" && target.pathname === "/_waifus_remote/v1/events") {
        return this.#events(request, reply, browserOwner(browserContext));
      }
      return reply.code(404).send({ error: "NotFound" });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: "InvalidRequest" });
      }
      if (error instanceof RememberedHostStoreError) {
        if (error.code === "host_not_found") return reply.code(404).send({ error: "NotFound" });
        if (error.code === "host_conflict") return reply.code(409).send({ error: "Conflict" });
      }
      return reply.code(503).send({ error: "RemoteUnavailable" });
    }
  };

  async closeSession(gatewayLaunchId: string, browserSessionId: string): Promise<void> {
    const owner = `${gatewayLaunchId}.${browserSessionId}`;
    const cancellations: Promise<unknown>[] = [];
    for (const [id, operation] of this.#activationOperations) {
      if (operation.ownerSessionId === owner) {
        this.#activationOperations.delete(id);
        if (!operation.status || operation.status.state === "pending") {
          cancellations.push(this.#backend.cancelActivation(id).catch(() => undefined));
        }
      }
    }
    for (const [id, operation] of this.#pairOperations) {
      if (operation.ownerSessionId === owner) {
        this.#pairOperations.delete(id);
        if (LIVE_PAIR_STATES.has(operation.status.state)) {
          cancellations.push(this.#backend.cancelPair(id).catch(() => undefined));
        }
      }
    }
    for (const subscriber of this.#eventSubscribers) {
      if (subscriber.ownerSessionId === owner) this.#eventSubscribers.delete(subscriber);
    }
    await Promise.all(cancellations);
  }

  async close(): Promise<void> {
    const cancellations: Promise<unknown>[] = [];
    for (const [id, operation] of this.#activationOperations) {
      if (!operation.status || operation.status.state === "pending") {
        cancellations.push(this.#backend.cancelActivation(id).catch(() => undefined));
      }
    }
    for (const [id, operation] of this.#pairOperations) {
      if (LIVE_PAIR_STATES.has(operation.status.state)) {
        cancellations.push(this.#backend.cancelPair(id).catch(() => undefined));
      }
    }
    this.#activationOperations.clear();
    this.#pairOperations.clear();
    this.#eventSubscribers.clear();
    this.#eventRecords.length = 0;
    await Promise.all(cancellations);
  }

  async #bootstrap(security: RemoteGatewayHandlerSecurity): Promise<GatewayBootstrapV1> {
    const [snapshot, hosts, selection] = await Promise.all([
      this.#backend.snapshot(),
      this.#rememberedHosts.list(),
      this.#rememberedHosts.selection()
    ]);
    return GatewayBootstrapV1Schema.parse({
      version: 1,
      gatewayVersion: snapshot.gatewayVersion,
      helperVersion: snapshot.helperVersion,
      helperReleaseSequence: snapshot.helperReleaseSequence,
      protocol: snapshot.protocol,
      capabilities: snapshot.capabilities,
      session: security.session,
      activationState: snapshot.activationState,
      helperState: snapshot.helperState,
      controlState: snapshot.controlState,
      directState: selection.selectedHostId === null ? "inactive" : snapshot.directState,
      rememberedHostCount: hosts.hosts.length,
      selectionState: selection.selectionState,
      selectedHostId: selection.selectedHostId,
      lastErrorCode: snapshot.lastErrorCode
    });
  }

  async #openSelectedHost(reply: FastifyReply, hostId: string): Promise<unknown> {
    reply.header("cache-control", "no-store");
    try {
      const [selection, snapshot, host] = await Promise.all([
        this.#rememberedHosts.selection(),
        this.#backend.snapshot(),
        this.#rememberedHosts.record(hostId)
      ]);
      if (
        !host
        || selection.selectedHostId !== host.hostId
        || snapshot.directState !== "direct"
        || !this.#issueSelectedHostBootstrap
      ) {
        return reply.code(409).send({ error: "DirectUnavailable" });
      }
      const rawBootstrapUrl = await this.#issueSelectedHostBootstrap(host);
      const bootstrapUrl = new URL(rawBootstrapUrl);
      if (
        bootstrapUrl.protocol !== "http:"
        || !/^waifus-[a-z2-7]{52}\.localhost$/u.test(bootstrapUrl.hostname)
        || !/^(?:[1-9][0-9]{0,4})$/u.test(bootstrapUrl.port)
        || Number(bootstrapUrl.port) > 65_535
        || !/^\/_waifus_remote\/bootstrap\/[A-Za-z0-9_-]{43}$/u.test(bootstrapUrl.pathname)
        || bootstrapUrl.search !== ""
        || bootstrapUrl.hash !== ""
        || bootstrapUrl.username !== ""
        || bootstrapUrl.password !== ""
        || bootstrapUrl.href !== rawBootstrapUrl
      ) {
        throw new Error("Selected-host bootstrap URL is invalid.");
      }
      return reply.code(303).header("location", bootstrapUrl.href).send();
    } catch {
      return reply.code(503).send({ error: "RemoteUnavailable" });
    }
  }

  async #shellAsset(
    request: FastifyRequest,
    reply: FastifyReply,
    target: { pathname: string; hasQuery: boolean }
  ): Promise<unknown> {
    if ((request.method !== "GET" && request.method !== "HEAD") || target.hasQuery) {
      return reply.code(404).send({ error: "NotFound" });
    }
    const isIndex = target.pathname === "/" || target.pathname === "/index.html";
    const assetMatch = target.pathname.match(
      /^\/assets\/index-[A-Za-z0-9_-]+\.(css|js)$/u
    );
    if (!isIndex && !assetMatch) return reply.code(404).send({ error: "NotFound" });
    const filePath = isIndex
      ? path.join(this.#shellRoot, "index.html")
      : path.join(this.#shellRoot, "assets", path.basename(target.pathname));
    try {
      const metadata = await lstat(filePath);
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 4 * 1_024 * 1_024) {
        return reply.code(404).send({ error: "NotFound" });
      }
      const contentType = isIndex
        ? "text/html; charset=utf-8"
        : assetMatch?.[1] === "css"
          ? "text/css; charset=utf-8"
          : "text/javascript; charset=utf-8";
      reply.header("content-type", contentType);
      reply.header(
        "cache-control",
        isIndex ? "no-store" : "public, max-age=31536000, immutable"
      );
      return reply.send(await readFile(filePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return reply.code(404).send({ error: "NotFound" });
      }
      throw error;
    }
  }

  async #beginActivation(ownerSessionId: string) {
    if (this.#activationOperations.size >= MAX_LOCAL_OPERATIONS) {
      throw new Error("Local activation operation capacity is exhausted.");
    }
    for (const [id, operation] of this.#activationOperations) {
      if (operation.ownerSessionId !== ownerSessionId) continue;
      if (BigInt(seconds(this.#now)) >= BigInt(operation.expiresAt)) {
        this.#activationOperations.delete(id);
        await this.#backend.cancelActivation(id).catch(() => undefined);
      } else if (!operation.status || operation.status.state === "pending") {
        throw new RememberedHostStoreError("host_conflict", "An activation operation is already live.");
      }
    }
    const operationId = this.#operationId();
    const started = await this.#backend.beginActivation(operationId);
    if (started.operationId !== operationId) {
      throw new Error("Activation helper response does not match its local operation.");
    }
    const result = ActivationStartResultSchema.parse({
      activationOperationId: operationId,
      verificationUrl: started.verificationUrl,
      expiresAt: started.expiresAt
    });
    this.#activationOperations.set(operationId, {
      ownerSessionId,
      expiresAt: result.expiresAt
    });
    this.#publish(ownerSessionId, {
      version: 1,
      type: "activation_operation_state_changed",
      activationOperationId: result.activationOperationId,
      state: "pending",
      at: seconds(this.#now)
    });
    return result;
  }

  async #pollActivation(ownerSessionId: string, operationIdValue: string) {
    const parsed = ActivationOperationIdSchema.safeParse(operationIdValue);
    if (!parsed.success) return undefined;
    const operation = this.#activationOperations.get(parsed.data);
    if (!operation || operation.ownerSessionId !== ownerSessionId) return undefined;
    if (operation.status) return operation.status;
    let status: ActivationStatus;
    if (BigInt(seconds(this.#now)) >= BigInt(operation.expiresAt)) {
      await this.#backend.cancelActivation(parsed.data).catch(() => undefined);
      status = ActivationStatusSchema.parse({
        activationOperationId: parsed.data,
        state: "expired",
        expiresAt: operation.expiresAt
      });
    } else {
      try {
        const helper = await this.#backend.pollActivation(parsed.data);
        if (helper.operationId !== parsed.data || helper.expiresAt !== operation.expiresAt) {
          throw new Error("Activation helper response does not match its local operation.");
        }
        status = ActivationStatusSchema.parse({
          activationOperationId: parsed.data,
          state: helper.state,
          expiresAt: helper.expiresAt,
          ...(helper.state === "completed" ? { completedAt: seconds(this.#now) } : {}),
          ...(helper.state === "failed" ? { errorCode: helper.errorCode } : {})
        });
      } catch {
        status = ActivationStatusSchema.parse({
          activationOperationId: parsed.data,
          state: "failed",
          expiresAt: operation.expiresAt,
          errorCode: "helper_unavailable"
        });
      }
    }
    if (status.state !== "pending") {
      operation.status = status;
      this.#publish(ownerSessionId, {
        version: 1,
        type: "activation_operation_state_changed",
        activationOperationId: status.activationOperationId,
        state: status.state,
        at: seconds(this.#now)
      });
    }
    return status;
  }

  async #cancelActivation(ownerSessionId: string, operationIdValue: string): Promise<boolean> {
    const parsed = ActivationOperationIdSchema.safeParse(operationIdValue);
    if (!parsed.success) return false;
    const operation = this.#activationOperations.get(parsed.data);
    if (!operation || operation.ownerSessionId !== ownerSessionId) return false;
    this.#activationOperations.delete(parsed.data);
    await this.#backend.cancelActivation(parsed.data).catch(() => undefined);
    this.#publish(ownerSessionId, {
      version: 1,
      type: "activation_operation_state_changed",
      activationOperationId: parsed.data,
      state: "cancelled",
      at: seconds(this.#now)
    });
    return true;
  }

  async #beginPair(ownerSessionId: string, input: PairStartInput) {
    if (this.#pairOperations.size >= MAX_LOCAL_OPERATIONS) {
      throw new Error("Local pair operation capacity is exhausted.");
    }
    for (const [id, operation] of this.#pairOperations) {
      if (
        operation.ownerSessionId === ownerSessionId
        && LIVE_PAIR_STATES.has(operation.status.state)
      ) {
        if (BigInt(seconds(this.#now)) >= BigInt(operation.expiresAt)) {
          this.#pairOperations.delete(id);
          await this.#backend.cancelPair(id).catch(() => undefined);
        } else {
          throw new RememberedHostStoreError("host_conflict", "A pair operation is already live.");
        }
      }
    }
    const operationId = this.#operationId();
    const begun = await this.#backend.beginPair(operationId, input);
    const result = PairStartResultSchema.parse({
      pairOperationId: operationId,
      statusUrl: statusUrl(operationId),
      state: "starting",
      expiresAt: begun.expiresAt
    });
    this.#pairOperations.set(operationId, {
      ownerSessionId,
      expiresAt: result.expiresAt,
      status: PairOperationStatusSchema.parse(result)
    });
    this.#publish(ownerSessionId, {
      version: 1,
      type: "pair_operation_state_changed",
      pairOperationId: result.pairOperationId,
      state: "starting",
      at: seconds(this.#now)
    });
    return result;
  }

  async #pollPair(ownerSessionId: string, operationIdValue: string) {
    const parsed = PairOperationIdSchema.safeParse(operationIdValue);
    if (!parsed.success) return undefined;
    const operation = this.#pairOperations.get(parsed.data);
    if (!operation || operation.ownerSessionId !== ownerSessionId) return undefined;
    if (!LIVE_PAIR_STATES.has(operation.status.state)) return operation.status;
    let status: PairOperationStatus;
    if (BigInt(seconds(this.#now)) >= BigInt(operation.expiresAt)) {
      await this.#backend.cancelPair(parsed.data).catch(() => undefined);
      status = PairOperationStatusSchema.parse({
        pairOperationId: parsed.data,
        statusUrl: statusUrl(parsed.data),
        state: "expired",
        expiresAt: operation.expiresAt
      });
    } else {
      try {
        status = PairOperationStatusSchema.parse(await this.#backend.pollPair(parsed.data));
        if (
          status.pairOperationId !== parsed.data
          || status.statusUrl !== statusUrl(parsed.data)
          || status.expiresAt !== operation.expiresAt
        ) {
          throw new Error("Pair helper response does not match its local operation.");
        }
        if (status.state === "completed") {
          operation.completion ??= this.#persistCompletedPair(parsed.data);
          await operation.completion;
        }
      } catch {
        status = PairOperationStatusSchema.parse({
          pairOperationId: parsed.data,
          statusUrl: statusUrl(parsed.data),
          state: "failed",
          expiresAt: operation.expiresAt,
          errorCode: "helper_unavailable"
        });
      }
    }
    const changed = status.state !== operation.status.state;
    operation.status = status;
    if (changed) {
      this.#publish(ownerSessionId, {
        version: 1,
        type: "pair_operation_state_changed",
        pairOperationId: status.pairOperationId,
        state: status.state,
        at: seconds(this.#now)
      });
    }
    return status;
  }

  async #persistCompletedPair(operationId: string): Promise<void> {
    const host = await this.#backend.consumeCompletedPair(operationId);
    await this.#rememberedHosts.upsert(host);
    this.#hostsChanged();
  }

  async #cancelPair(ownerSessionId: string, operationIdValue: string): Promise<boolean> {
    const parsed = PairOperationIdSchema.safeParse(operationIdValue);
    if (!parsed.success) return false;
    const operation = this.#pairOperations.get(parsed.data);
    if (!operation || operation.ownerSessionId !== ownerSessionId) return false;
    this.#pairOperations.delete(parsed.data);
    await this.#backend.cancelPair(parsed.data).catch(() => undefined);
    this.#publish(ownerSessionId, {
      version: 1,
      type: "pair_operation_state_changed",
      pairOperationId: parsed.data,
      state: "cancelled",
      at: seconds(this.#now)
    });
    return true;
  }

  async #connect(hostId: string) {
    const host = await this.#requireHost(hostId);
    await this.#backend.connectRememberedHost(host);
    await this.#rememberedHosts.select(host.hostId);
    await this.#rememberedHosts.updateConnection(host.hostId, "reconnecting", null, null);
    const result = ConnectRememberedHostResultV1Schema.parse({
      hostId: host.hostId,
      action: "connect",
      state: "connecting",
      acceptedAt: seconds(this.#now)
    });
    this.#publish(null, {
      version: 1,
      type: "host_selection_changed",
      hostId: host.hostId,
      selectionState: "explicit",
      at: seconds(this.#now)
    });
    return result;
  }

  async #disconnect(hostId: string) {
    const host = await this.#requireHost(hostId);
    await this.#backend.disconnectRememberedHost(host);
    await this.#rememberedHosts.updateConnection(host.hostId, "offline", host.lastDirectAt, null);
    const result = DisconnectRememberedHostResultV1Schema.parse({
      hostId: host.hostId,
      action: "disconnect",
      state: "offline",
      completedAt: seconds(this.#now)
    });
    this.#publish(null, {
      version: 1,
      type: "host_connection_changed",
      hostId: host.hostId,
      state: "offline",
      at: seconds(this.#now)
    });
    return result;
  }

  async #forget(hostId: string, input: z.infer<typeof ForgetRememberedHostInputV1Schema>) {
    const host = await this.#requireHost(hostId);
    if (host.revision !== input.revision) {
      throw new RememberedHostStoreError("host_conflict", "Remembered host revision changed.");
    }
    if (input.mode === "reachable_first") {
      const signed = await this.#backend.requestSignedSelfRevocation(host);
      if (!signed) {
        return ForgetRememberedHostResultV1Schema.parse({
          hostId: host.hostId,
          state: "local_only_confirmation_required",
          revision: host.revision,
          warningCode: "host_unreachable_remote_trust_may_remain",
          requiredMode: "local_only_confirmed"
        });
      }
      await this.#origins.advanceForForget(host.hostId);
      await this.#backend.forgetRememberedHost(host);
      await this.#rememberedHosts.remove(host.hostId, input.revision);
      const result = ForgetRememberedHostResultV1Schema.parse({
        hostId: host.hostId,
        state: "forgotten",
        revocation: "signed_self_revocation",
        forgottenAt: seconds(this.#now)
      });
      this.#hostsChanged();
      return result;
    }
    await this.#origins.advanceForForget(host.hostId);
    await this.#backend.forgetRememberedHost(host);
    await this.#rememberedHosts.remove(host.hostId, input.revision);
    const result = ForgetRememberedHostResultV1Schema.parse({
      hostId: host.hostId,
      state: "forgotten",
      revocation: "local_only",
      warningCode: "host_unreachable_remote_trust_may_remain",
      forgottenAt: seconds(this.#now)
    });
    this.#hostsChanged();
    return result;
  }

  async #requireHost(hostIdValue: string): Promise<RememberedHostRecordV1> {
    const parsed = Base64Url32BytesSchema.safeParse(hostIdValue);
    if (!parsed.success) throw new RememberedHostStoreError("host_not_found", "Host is missing.");
    const host = await this.#rememberedHosts.record(parsed.data);
    if (!host) throw new RememberedHostStoreError("host_not_found", "Host is missing.");
    return host;
  }

  #operationId(): string {
    for (let attempt = 0; attempt < MAX_OPERATION_ID_ATTEMPTS; attempt += 1) {
      const id = Base64Url32BytesSchema.parse(
        exactRandomBytes(this.#random, 32, "Local operation ID").toString("base64url")
      );
      if (!this.#activationOperations.has(id) && !this.#pairOperations.has(id)) return id;
    }
    throw new Error("Local operation ID random source repeatedly collided.");
  }

  #publish(ownerSessionId: string | null, eventValue: GatewayLocalEventV1): void {
    const event = GatewayLocalEventV1Schema.parse(eventValue);
    if (this.#eventSequence >= UINT64_MAX) {
      throw new Error("Local event cursor sequence is exhausted.");
    }
    this.#eventSequence += 1n;
    const record: LocalEventRecord = Object.freeze({
      cursor: `v1:${this.#eventEpoch}:${this.#eventSequence}`,
      ownerSessionId,
      event: Object.freeze(event)
    });
    this.#eventRecords.push(record);
    while (this.#eventRecords.length > MAX_EVENT_RECORDS) this.#eventRecords.shift();
    for (const subscriber of this.#eventSubscribers) {
      if (ownerSessionId === null || ownerSessionId === subscriber.ownerSessionId) {
        subscriber.send(record);
      }
    }
  }

  #hostsChanged(): void {
    this.#publish(null, {
      version: 1,
      type: "remembered_hosts_changed",
      at: seconds(this.#now)
    });
  }

  #events(request: FastifyRequest, reply: FastifyReply, ownerSessionId: string): void {
    reply.hijack();
    reply.raw.writeHead(200, {
      ...SHELL_SECURITY_HEADERS,
      "cache-control": "no-store",
      "content-type": "text/event-stream; charset=utf-8",
      connection: "keep-alive"
    });
    reply.raw.write(": connected\n\n");
    const subscriber: LocalEventSubscriber = {
      ownerSessionId,
      send: (record) => reply.raw.write(eventBytes(record))
    };
    this.#eventSubscribers.add(subscriber);
    const lastEventId = typeof request.headers["last-event-id"] === "string"
      ? request.headers["last-event-id"]
      : undefined;
    if (lastEventId) {
      const position = this.#eventRecords.findIndex((record) => record.cursor === lastEventId);
      if (position >= 0) {
        for (const record of this.#eventRecords.slice(position + 1)) {
          if (record.ownerSessionId === null || record.ownerSessionId === ownerSessionId) {
            subscriber.send(record);
          }
        }
      } else {
        reply.raw.write(`event: snapshot_required\ndata: {"reason":"cursor_gap"}\n\n`);
      }
    }
    reply.raw.once("close", () => this.#eventSubscribers.delete(subscriber));
  }
}

export function isRemoteLocalApiTarget(canonicalTarget: string): boolean {
  const { pathname } = localPath(canonicalTarget);
  return pathname.startsWith("/_waifus_remote/v1/");
}
