import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { lstat, chmod } from "node:fs/promises";
import net, { type Socket } from "node:net";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { TextDecoder } from "node:util";
import { z } from "zod";
import type {
  RemoteBridgeConnection,
  RemoteBridgeResponse,
  RemoteRequestBridge
} from "../backend/remoteAccess/requestBridge.js";
import {
  Base64Url16BytesSchema,
  Base64Url32BytesSchema,
  CanonicalTargetSchema,
  ComponentHelloSchema,
  DeviceIdSchema,
  HttpMethodSchema,
  RemoteBrowserContextV1Schema,
  Uint64DecimalSchema,
  negotiateComponentCompatibility,
  type ComponentHello,
  type ProtocolVersion
} from "../shared/schemas/remoteProtocol.js";
import {
  serializeCanonicalContractJson,
  type ContractJson
} from "../shared/schemas/remoteProtocolContract.js";
import {
  ApprovePairingInputV1Schema,
  PairInvitationV1Schema,
  PendingPairingRequestListV1Schema,
  RenameTrustedDeviceInputV1Schema,
  RemoteAccessErrorCodeSchema,
  TrustedDeviceListV1Schema,
  TrustedDeviceSummaryV1Schema,
  type ApprovePairingInputV1,
  type PairInvitationV1,
  type PendingPairingRequestListV1,
  type RenameTrustedDeviceInputV1,
  type TrustedDeviceListV1,
  type TrustedDeviceSummaryV1
} from "../shared/schemas/remoteLifecycle.js";
import {
  WIPC_FRAME_TYPES,
  WIPC_HEADER_BYTES,
  WIPC_PROTOCOL_VERSION,
  WIPC_DATA_PAYLOAD_MAX_BYTES,
  WIPC_MAX_CONCURRENT_STREAMS,
  assertWipcEncodedHeadersLength,
  decodeWipcHeader,
  decodeWipcWindowUpdate,
  encodeWipcHeader,
  encodeWipcWindowUpdate,
  nextWipcStreamId,
  type WipcFrameType
} from "../shared/wipc.js";
import { WipcParentAuthSession } from "../shared/wipcAuthSession.js";
import { WipcConnectionState, type WipcStreamTransition } from "../shared/wipcState.js";
import {
  HelperStreamError,
  HelperSupervisorError,
  HELPER_COMMAND_TIMEOUT_MS,
  HelperCommandError,
  HelperActivationCancelSchema,
  HelperActivationErrorCodeSchema,
  HelperActivationPollSchema,
  HelperActivationStartSchema,
  HelperConfirmedAdminActorSchema,
  HelperIdentityStatusSchema,
  HelperRequestActorSchema,
  parseHelperRuntimeStatus,
  type AuthenticatedHelperClient,
  type HelperActivationCancel,
  type HelperActivationPoll,
  type HelperActivationStart,
  type HelperIdentityStatus,
  type HelperConfirmedAdminActor,
  type HelperLaunch,
  type HelperLaunchRequest,
  type HelperProcessExit,
  type HelperProcessFactory,
  type HelperRemoteRequest,
  type HelperRemoteResponse,
  type HelperRequestActor,
  type HelperRuntimeStatus
} from "./helperTypes.js";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const AuthenticateParentResultSchema = z.object({
  helperProof: Base64Url32BytesSchema
}).strict();
const HelperCommandFailureSchema = z.object({
  command: z.enum([
    "activation_begin",
    "activation_poll",
    "activation_cancel",
    "identity_status",
    "runtime_start",
    "runtime_status",
    "runtime_reconnect",
    "runtime_stop",
    "register_gateway_launch",
    "invitation_create",
    "invitation_cancel",
    "pairing_requests_list",
    "pairing_request_approve",
    "pairing_request_reject",
    "trusted_devices_list",
    "trusted_device_rename",
    "trusted_device_revoke"
  ]),
  errorCode: z.union([HelperActivationErrorCodeSchema, RemoteAccessErrorCodeSchema]),
  ok: z.literal(false),
  operationId: Base64Url32BytesSchema.optional(),
  invitationId: Base64Url16BytesSchema.optional(),
  requestId: Base64Url16BytesSchema.optional(),
  deviceId: DeviceIdSchema.optional()
}).strict();
const IdentityStatusWireSchema = z.object({
  activationState: z.enum(["activation_required", "active", "renewal_due"]),
  command: z.literal("identity_status"),
  deviceId: z.string(),
  installationFingerprint: z.string(),
  ok: z.literal(true),
  secretStorage: z.enum([
    "keychain",
    "windows_protected_storage",
    "secret_service",
    "protected_file_fallback",
    "unavailable"
  ])
}).strict();
const ActivationBeginWireSchema = z.object({
  command: z.literal("activation_begin"),
  expiresAt: z.string(),
  ok: z.literal(true),
  operationId: Base64Url32BytesSchema,
  verificationUrl: z.string()
}).strict();
const ActivationPollWireSchema = z.union([
  z.object({
    command: z.literal("activation_poll"),
    expiresAt: z.string(),
    ok: z.literal(true),
    operationId: Base64Url32BytesSchema,
    state: z.enum(["pending", "completed", "expired"])
  }).strict(),
  z.object({
    command: z.literal("activation_poll"),
    errorCode: HelperActivationErrorCodeSchema,
    expiresAt: z.string(),
    ok: z.literal(true),
    operationId: Base64Url32BytesSchema,
    state: z.literal("failed")
  }).strict()
]);
const ActivationCancelWireSchema = z.object({
  cancelled: z.literal(true),
  command: z.literal("activation_cancel"),
  ok: z.literal(true),
  operationId: Base64Url32BytesSchema
}).strict();
const RuntimeStatusWireSchema = z.object({
  activationState: z.enum(["activation_required", "active", "renewal_due"]),
  command: z.enum(["runtime_start", "runtime_status", "runtime_reconnect", "runtime_stop"]),
  controlState: z.enum(["inactive", "connecting", "connected", "reconnecting", "unavailable"]),
  directState: z.enum(["inactive", "direct", "reconnecting", "direct_unavailable"]),
  lastDirectAt: Uint64DecimalSchema.nullable(),
  lastErrorCode: RemoteAccessErrorCodeSchema.nullable(),
  ok: z.literal(true)
}).strict();
const RegisterGatewayLaunchWireSchema = z.object({
  command: z.literal("register_gateway_launch"),
  ok: z.literal(true)
}).strict();
const InvitationCreateWireSchema = PairInvitationV1Schema.extend({
  command: z.literal("invitation_create"),
  ok: z.literal(true)
});
const InvitationCancelWireSchema = z.object({
  command: z.literal("invitation_cancel"),
  invitationId: Base64Url16BytesSchema,
  ok: z.literal(true)
}).strict();
const PairingRequestsListWireSchema = PendingPairingRequestListV1Schema.extend({
  command: z.literal("pairing_requests_list"),
  ok: z.literal(true)
});
const PairingRequestApproveWireSchema = z.object({
  command: z.literal("pairing_request_approve"),
  requestId: Base64Url16BytesSchema,
  ok: z.literal(true)
}).strict();
const PairingRequestRejectWireSchema = z.object({
  command: z.literal("pairing_request_reject"),
  requestId: Base64Url16BytesSchema,
  ok: z.literal(true)
}).strict();
const TrustedDevicesListWireSchema = TrustedDeviceListV1Schema.extend({
  command: z.literal("trusted_devices_list"),
  ok: z.literal(true)
});
const TrustedDeviceRenameWireSchema = TrustedDeviceSummaryV1Schema.extend({
  command: z.literal("trusted_device_rename"),
  ok: z.literal(true)
});
const TrustedDeviceRevokeWireSchema = z.object({
  command: z.literal("trusted_device_revoke"),
  deviceId: DeviceIdSchema,
  ok: z.literal(true)
}).strict();
const HeaderTupleWireSchema = z.tuple([
  z.string().min(1).max(128).regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u),
  z.string().max(8_192).regex(/^[\t\x20-\x7E]*$/u)
]);
const HeaderBlockWireSchema = z.array(HeaderTupleWireSchema).max(256).superRefine(
  (headers, context) => {
    try {
      assertWipcEncodedHeadersLength(canonicalBytes(headers).byteLength);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Encoded HTTP headers exceed 16 KiB."
      });
    }
  }
);
const RemoteParentRequestStartWireSchema = z.object({
  version: z.literal(1),
  method: HttpMethodSchema,
  canonicalTarget: CanonicalTargetSchema,
  headers: HeaderBlockWireSchema,
  browserContext: RemoteBrowserContextV1Schema
}).strict().refine(
  (value) => value.method === value.browserContext.method
    && value.canonicalTarget === value.browserContext.canonicalTarget,
  "Remote browser context must match the request method and target."
);
const ResponseStartWireSchema = z.object({
  version: z.literal(1),
  statusCode: z.number().int().min(100).max(599),
  statusMessage: z.string().max(256).regex(/^[\t\x20-\x7E]*$/u),
  headers: HeaderBlockWireSchema
}).strict();
const StreamErrorWireSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
  message: z.string().min(1).max(1_024).regex(/^[^\u0000-\u001F\u007F]+$/u)
}).strict();

type WipcFrame = {
  readonly type: WipcFrameType;
  readonly streamId: bigint;
  readonly payload: Buffer;
};

type PendingCommand = {
  resolve: (frame: WipcFrame) => void;
  reject: (error: Error) => void;
};

type ActiveHostStream = {
  readonly kind: "host";
  readonly streamId: bigint;
  readonly body: PassThrough;
  readonly controller: AbortController;
  requestWriteTail: Promise<void>;
  response: RemoteBridgeResponse | undefined;
  readonly responseCreditWaiters: Set<() => void>;
  closed: boolean;
};

type ActiveRemoteStream = {
  readonly kind: "remote";
  readonly streamId: bigint;
  readonly body: PassThrough;
  readonly requestBody: Readable | undefined;
  readonly controller: AbortController;
  readonly requestCreditWaiters: Set<() => void>;
  responseWriteTail: Promise<void>;
  resolveResponse: (response: HelperRemoteResponse) => void;
  rejectResponse: (error: Error) => void;
  removeExternalAbort: () => void;
  closed: boolean;
};

type ActiveStream = ActiveHostStream | ActiveRemoteStream;

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(serializeCanonicalContractJson(value as ContractJson), "utf8");
}

function commandResultMatches(
  result: Record<string, unknown>,
  command: Record<string, unknown>
): boolean {
  if (result.command !== command.command) return false;
  for (const field of ["operationId", "invitationId", "requestId", "deviceId"] as const) {
    if (command[field] !== undefined && result[field] !== command[field]) return false;
  }
  return true;
}

function parseCanonical<T>(
  bytes: Buffer,
  schema: z.ZodType<T>,
  label: string
): T {
  let decoded: unknown;
  try {
    decoded = JSON.parse(UTF8_DECODER.decode(bytes));
  } catch {
    throw new HelperSupervisorError("helper_incompatible", `${label} is not canonical UTF-8 JSON.`);
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success || !canonicalBytes(parsed.data).equals(bytes)) {
    throw new HelperSupervisorError("helper_incompatible", `${label} violates its strict canonical schema.`);
  }
  return parsed.data;
}

function waitForReadable(socket: Socket): Promise<void> {
  if (socket.readableLength > 0) return Promise.resolve();
  if (socket.destroyed || socket.readableEnded) {
    return Promise.reject(new Error("Protected helper socket closed during a WIPC frame."));
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("readable", onReadable);
      socket.off("end", onEnded);
      socket.off("close", onEnded);
      socket.off("error", onError);
    };
    const onReadable = () => {
      cleanup();
      resolve();
    };
    const onEnded = () => {
      cleanup();
      reject(new Error("Protected helper socket closed during a WIPC frame."));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.once("readable", onReadable);
    socket.once("end", onEnded);
    socket.once("close", onEnded);
    socket.once("error", onError);
    if (socket.readableLength > 0) onReadable();
  });
}

async function readExactly(socket: Socket, size: number): Promise<Buffer> {
  const result = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const readableBytes = Math.min(size - offset, socket.readableLength);
    const chunk = readableBytes > 0
      ? socket.read(readableBytes) as Buffer | null
      : null;
    if (!chunk) {
      await waitForReadable(socket);
      continue;
    }
    chunk.copy(result, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function readFrame(socket: Socket): Promise<WipcFrame> {
  const header = decodeWipcHeader(await readExactly(socket, WIPC_HEADER_BYTES));
  return {
    type: header.frameType,
    streamId: header.streamId,
    payload: await readExactly(socket, header.payloadLength)
  };
}

async function writeFrame(
  socket: Socket,
  type: WipcFrameType,
  payload: Buffer,
  streamId = 0n
): Promise<void> {
  const header = encodeWipcHeader({
    ...WIPC_PROTOCOL_VERSION,
    frameType: type,
    flags: 0,
    streamId,
    payloadLength: payload.byteLength
  });
  const encoded = Buffer.concat([header, payload]);
  await new Promise<void>((resolve, reject) => {
    socket.write(encoded, (error) => error ? reject(error) : resolve());
  });
}

function requireFrame(frame: WipcFrame, expected: WipcFrameType, label: string): void {
  if (frame.type !== expected || frame.streamId !== 0n) {
    throw new HelperSupervisorError("helper_incompatible", `Expected ${label} during the helper protocol exchange.`);
  }
}

function assertOwnedMode(
  metadata: Awaited<ReturnType<typeof lstat>>,
  mode: number,
  label: string
): void {
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new HelperSupervisorError("helper_unavailable", `${label} is not owned by the current user.`);
  }
  if ((Number(metadata.mode) & 0o777) !== mode) {
    throw new HelperSupervisorError("helper_unavailable", `${label} has unsafe permissions.`);
  }
}

async function validateUnixRuntimeDirectory(endpoint: string): Promise<void> {
  if (!path.isAbsolute(endpoint) || path.normalize(endpoint) !== endpoint) {
    throw new HelperSupervisorError("helper_unavailable", "Parent Unix endpoint is not a clean absolute path.");
  }
  if (Buffer.byteLength(endpoint, "utf8") > 103) {
    throw new HelperSupervisorError("helper_unavailable", "Parent Unix endpoint exceeds 103 bytes.");
  }
  const runtimeDirectory = await lstat(path.dirname(endpoint));
  if (runtimeDirectory.isSymbolicLink() || !runtimeDirectory.isDirectory()) {
    throw new HelperSupervisorError("helper_unavailable", "Parent runtime directory is not a real directory.");
  }
  assertOwnedMode(runtimeDirectory, 0o700, "Parent runtime directory");
  try {
    await lstat(endpoint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new HelperSupervisorError("helper_unavailable", "Parent Unix endpoint already exists.");
}

async function listenProtectedUnix(server: net.Server, endpoint: string): Promise<void> {
  await validateUnixRuntimeDirectory(endpoint);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });
  await chmod(endpoint, 0o600);
  const socketMetadata = await lstat(endpoint);
  if (socketMetadata.isSymbolicLink() || !socketMetadata.isSocket()) {
    throw new HelperSupervisorError("helper_unavailable", "Parent endpoint is not a real Unix socket.");
  }
  assertOwnedMode(socketMetadata, 0o600, "Parent Unix socket");
}

function forwardWipcTransition(transition: WipcStreamTransition): boolean {
  return ![
    "request_chunk_discarded",
    "cancel_ignored",
    "window_ignored",
    "inactive_frame_ignored"
  ].includes(transition.outcome);
}

function boundedStreamError(code: string, message: string): Buffer {
  return canonicalBytes({ code, message });
}

class ProcessHelperClient implements AuthenticatedHelperClient {
  readonly hello: ComponentHello;
  readonly negotiatedProtocol: ProtocolVersion;
  readonly negotiatedCapabilities: readonly string[];
  readonly #socket: Socket;
  readonly #authentication: WipcParentAuthSession;
  readonly #connectionState = new WipcConnectionState();
  #status: HelperRuntimeStatus;
  readonly #dataRoot: string;
  readonly #role: "host" | "remote";
  readonly #statusListeners = new Set<(status: HelperRuntimeStatus) => void>();
  readonly #streams = new Map<bigint, ActiveStream>();
  #pendingCommand: PendingCommand | undefined;
  #bridgeConnection: RemoteBridgeConnection | undefined;
  #terminalError: Error | undefined;
  #commandTail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(
    socket: Socket,
    hello: ComponentHello,
    negotiatedProtocol: ProtocolVersion,
    negotiatedCapabilities: readonly string[],
    dataRoot: string,
    role: "host" | "remote",
    authentication: WipcParentAuthSession
  ) {
    this.#socket = socket;
    this.#authentication = authentication;
    this.hello = Object.freeze(hello);
    this.negotiatedProtocol = Object.freeze(negotiatedProtocol);
    this.negotiatedCapabilities = Object.freeze([...negotiatedCapabilities]);
    this.#dataRoot = dataRoot;
    this.#role = role;
    this.#status = Object.freeze(parseHelperRuntimeStatus({
      activationState: "activation_required",
      controlState: "inactive",
      directState: "inactive",
      lastDirectAt: null,
      lastErrorCode: null
    }));
    this.#connectionState.markAuthenticated();
    void this.#readLoop();
  }

  currentStatus(): HelperRuntimeStatus {
    return this.#status;
  }

  subscribeStatus(listener: (status: HelperRuntimeStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  async request(input: HelperRemoteRequest): Promise<HelperRemoteResponse> {
    if (this.#role !== "remote") {
      throw new HelperSupervisorError(
        "helper_incompatible",
        "Only a remote-role helper client may open host requests."
      );
    }
    if (this.#closed || this.#socket.destroyed || this.#terminalError) {
      throw new HelperSupervisorError("helper_unavailable", "Helper request channel is closed.");
    }
    if (input.signal?.aborted) {
      throw new HelperStreamError("cancelled", "Remote request was cancelled before dispatch.");
    }
    const start = RemoteParentRequestStartWireSchema.parse({
      version: 1,
      method: input.method,
      canonicalTarget: input.canonicalTarget,
      headers: input.headers,
      browserContext: input.browserContext
    });
    if (this.#connectionState.activeStreamCount >= WIPC_MAX_CONCURRENT_STREAMS) {
      throw new HelperStreamError(
        "stream_limit",
        "The helper connection already has 128 active requests."
      );
    }
    const highest = this.#connectionState.highWaterSnapshot().highestNodeStreamId;
    const streamId = nextWipcStreamId("node", highest);
    const body = new PassThrough({ highWaterMark: WIPC_DATA_PAYLOAD_MAX_BYTES });
    body.on("error", () => {});
    const controller = new AbortController();
    let resolveResponse!: (response: HelperRemoteResponse) => void;
    let rejectResponse!: (error: Error) => void;
    const responsePromise = new Promise<HelperRemoteResponse>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    // Cancellation may happen while REQUEST_START is still flushing. Keep the inner promise
    // observed until this async method returns it to the caller.
    void responsePromise.catch(() => undefined);
    const onExternalAbort = () => {
      this.#cancelRemoteStream(stream, input.signal?.reason);
    };
    const stream: ActiveRemoteStream = {
      kind: "remote",
      streamId,
      body,
      requestBody: input.body,
      controller,
      requestCreditWaiters: new Set(),
      responseWriteTail: Promise.resolve(),
      resolveResponse,
      rejectResponse,
      removeExternalAbort: () => input.signal?.removeEventListener("abort", onExternalAbort),
      closed: false
    };
    this.#streams.set(streamId, stream);
    input.signal?.addEventListener("abort", onExternalAbort, { once: true });
    try {
      await this.#sendStreamFrame(stream, WIPC_FRAME_TYPES.REQUEST_START, canonicalBytes(start));
      if (stream.controller.signal.aborted) {
        return responsePromise;
      }
      if (input.body) {
        void this.#pumpRemoteRequestBody(stream, input.body);
      } else {
        await this.#sendStreamFrame(stream, WIPC_FRAME_TYPES.REQUEST_END, Buffer.alloc(0));
      }
    } catch (error) {
      if (stream.controller.signal.aborted) return responsePromise;
      this.#failConnection(error);
      throw new HelperSupervisorError("helper_unavailable", "Helper request channel failed.");
    }
    return responsePromise;
  }

  async #pumpRemoteRequestBody(
    stream: ActiveRemoteStream,
    source: AsyncIterable<unknown>
  ): Promise<void> {
    try {
      for await (const value of source) {
        const chunk = Buffer.from(value as Uint8Array);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const available = await this.#waitForRequestCredit(stream);
          const size = Math.min(
            WIPC_DATA_PAYLOAD_MAX_BYTES,
            available,
            chunk.byteLength - offset
          );
          await this.#sendStreamFrame(
            stream,
            WIPC_FRAME_TYPES.REQUEST_CHUNK,
            chunk.subarray(offset, offset + size)
          );
          offset += size;
        }
      }
      if (!stream.closed && !stream.controller.signal.aborted) {
        await this.#sendStreamFrame(stream, WIPC_FRAME_TYPES.REQUEST_END, Buffer.alloc(0));
      }
    } catch (error) {
      this.#cancelRemoteStream(stream, error);
    }
  }

  async #waitForRequestCredit(stream: ActiveRemoteStream): Promise<number> {
    for (;;) {
      if (stream.closed || this.#closed || stream.controller.signal.aborted) {
        throw new Error("Helper request stream is closed.");
      }
      const snapshot = this.#connectionState.snapshot(stream.streamId);
      if (!snapshot || snapshot.requestState !== "open") {
        throw new Error("Helper request stream is no longer writable.");
      }
      if (snapshot.requestCredit > 0) return snapshot.requestCredit;
      await new Promise<void>((resolve) => stream.requestCreditWaiters.add(resolve));
    }
  }

  attachRequestBridge(bridge: RemoteRequestBridge): void {
    if (this.#role !== "host") {
      throw new HelperSupervisorError(
        "helper_incompatible",
        "Only a host-role helper client may attach the Fastify request bridge."
      );
    }
    if (this.#closed || this.#terminalError) {
      throw new HelperSupervisorError("helper_unavailable", "Helper request channel is closed.");
    }
    if (this.#bridgeConnection) {
      throw new HelperSupervisorError("helper_incompatible", "Helper request bridge is already attached.");
    }
    this.#bridgeConnection = bridge.openAuthenticatedConnection(
      `helper:${this.hello.nonce}`,
      this.#authentication
    );
  }

  #publishStatus(value: unknown): HelperRuntimeStatus {
    const status = Object.freeze(parseHelperRuntimeStatus(value));
    this.#status = status;
    for (const listener of this.#statusListeners) listener(status);
    return status;
  }

  async #readLoop(): Promise<void> {
    try {
      while (!this.#closed) {
        const frame = await readFrame(this.#socket);
        if (frame.streamId === 0n) {
          this.#handleConnectionFrame(frame);
        } else {
          await this.#handleStreamFrame(frame);
        }
      }
    } catch (error) {
      if (!this.#closed) this.#failConnection(error);
    }
  }

  #handleConnectionFrame(frame: WipcFrame): void {
    if (frame.type !== WIPC_FRAME_TYPES.RESULT || !this.#pendingCommand) {
      throw new HelperSupervisorError(
        "helper_incompatible",
        "Helper sent an unexpected post-authentication connection frame."
      );
    }
    const pending = this.#pendingCommand;
    this.#pendingCommand = undefined;
    pending.resolve(frame);
  }

  #decodedRequestStart(payload: Buffer): unknown {
    let value: unknown;
    try {
      value = JSON.parse(UTF8_DECODER.decode(payload));
    } catch {
      throw new HelperSupervisorError("helper_incompatible", "Helper request metadata is not UTF-8 JSON.");
    }
    if (!canonicalBytes(value).equals(payload)) {
      throw new HelperSupervisorError("helper_incompatible", "Helper request metadata is not canonical.");
    }
    return value;
  }

  #receiveStreamFrame(frame: WipcFrame): WipcStreamTransition {
    return this.#connectionState.receive({
      sender: "helper",
      frameType: frame.type,
      streamId: frame.streamId,
      ...(frame.type === WIPC_FRAME_TYPES.REQUEST_CHUNK
        || frame.type === WIPC_FRAME_TYPES.RESPONSE_CHUNK
        ? { payloadLength: frame.payload.byteLength }
        : {}),
      ...(frame.type === WIPC_FRAME_TYPES.WINDOW_UPDATE
        ? { windowUpdate: decodeWipcWindowUpdate(frame.payload) }
        : {})
    });
  }

  async #handleStreamFrame(frame: WipcFrame): Promise<void> {
    const transition = this.#receiveStreamFrame(frame);
    if (transition.outcome === "stream_limit") {
      await writeFrame(
        this.#socket,
        WIPC_FRAME_TYPES.RESPONSE_ERROR,
        boundedStreamError("stream_limit", "too many concurrent requests"),
        frame.streamId
      );
      return;
    }
    if (transition.outcome === "stream_failed") {
      const failedStream = this.#streams.get(frame.streamId);
      if (failedStream?.kind === "host" && transition.responseErrorPermitted) {
        await writeFrame(
          this.#socket,
          WIPC_FRAME_TYPES.RESPONSE_ERROR,
          boundedStreamError(transition.errorCode ?? "stream_protocol", "stream protocol violation"),
          frame.streamId
        );
      }
      this.#removeStream(frame.streamId, new Error("Helper stream protocol failed."));
      return;
    }
    if (!forwardWipcTransition(transition)) return;
    if (transition.outcome === "request_started") {
      const body = new PassThrough({ highWaterMark: WIPC_DATA_PAYLOAD_MAX_BYTES });
      body.on("error", () => {});
      const stream: ActiveHostStream = {
        kind: "host",
        streamId: frame.streamId,
        body,
        controller: new AbortController(),
        requestWriteTail: Promise.resolve(),
        response: undefined,
        responseCreditWaiters: new Set(),
        closed: false
      };
      this.#streams.set(frame.streamId, stream);
      let requestStart: unknown;
      try {
        requestStart = this.#decodedRequestStart(frame.payload);
      } catch (error) {
        void this.#rejectHostStream(stream, "invalid_request", "request metadata is invalid", error);
        return;
      }
      void this.#dispatchHostStream(stream, requestStart);
      return;
    }

    const stream = this.#streams.get(frame.streamId);
    if (!stream) {
      throw new HelperSupervisorError("helper_incompatible", "Active helper stream has no request owner.");
    }
    if (stream.kind === "remote") {
      this.#handleRemoteStreamFrame(stream, transition, frame);
      return;
    }
    switch (transition.outcome) {
      case "request_chunk_delivered":
        this.#enqueueRequestChunk(stream, Buffer.from(frame.payload));
        return;
      case "request_ended":
        stream.requestWriteTail = stream.requestWriteTail.then(() => {
          if (!stream.body.destroyed && !stream.body.writableEnded) stream.body.end();
          const snapshot = this.#connectionState.snapshot(stream.streamId);
          if (snapshot && ["succeeded", "failed"].includes(snapshot.responseState)) {
            this.#removeStream(stream.streamId);
          }
        }).catch((error) => this.#failConnection(error));
        return;
      case "request_cancelled":
        this.#cancelHostStream(stream, new Error("Remote request was cancelled."));
        return;
      case "window_updated":
        if (transition.direction === "response") this.#wakeResponseCredit(stream);
        return;
      default:
        throw new HelperSupervisorError("helper_incompatible", "Helper stream transition is unsupported.");
    }
  }

  #handleRemoteStreamFrame(
    stream: ActiveRemoteStream,
    transition: WipcStreamTransition,
    frame: WipcFrame
  ): void {
    if (transition.closeRequestInput && stream.requestBody && !stream.requestBody.destroyed) {
      stream.requestBody.destroy(new Error("Remote response closed the request upload."));
    }
    switch (transition.outcome) {
      case "response_started": {
        const response = parseCanonical(
          frame.payload,
          ResponseStartWireSchema,
          "Helper response metadata"
        );
        stream.body.once("close", () => {
          if (!stream.body.readableEnded && !stream.closed) {
            this.#cancelRemoteStream(stream, new HelperStreamError(
              "cancelled",
              "Remote response consumer disconnected."
            ));
          }
        });
        stream.resolveResponse(Object.freeze({
          statusCode: response.statusCode,
          statusMessage: response.statusMessage,
          headers: Object.freeze(response.headers.map((header) => Object.freeze(header))),
          body: stream.body,
          cancel: (reason?: unknown) => this.#cancelRemoteStream(stream, reason)
        }));
        return;
      }
      case "response_chunk_delivered":
        this.#enqueueResponseChunk(stream, Buffer.from(frame.payload));
        return;
      case "response_ended":
        stream.responseWriteTail = stream.responseWriteTail.then(async () => {
          if (!stream.body.destroyed && !stream.body.writableEnded) stream.body.end();
          await this.#finishRemoteRequestInput(stream);
          this.#removeStream(stream.streamId, undefined, true);
        }).catch((error) => this.#failConnection(error));
        return;
      case "response_failed": {
        const decoded = parseCanonical(
          frame.payload,
          StreamErrorWireSchema,
          "Helper stream error"
        );
        const error = new HelperStreamError(decoded.code, decoded.message);
        stream.rejectResponse(error);
        if (!stream.body.destroyed) stream.body.destroy(error);
        void this.#finishRemoteRequestInput(stream).then(() => {
          this.#removeStream(stream.streamId, error);
        }).catch((sendError) => this.#failConnection(sendError));
        return;
      }
      case "window_updated":
        if (transition.direction === "request") this.#wakeRequestCredit(stream);
        return;
      default:
        throw new HelperSupervisorError(
          "helper_incompatible",
          "Helper remote stream transition is unsupported."
        );
    }
  }

  async #finishRemoteRequestInput(stream: ActiveRemoteStream): Promise<void> {
    if (this.#connectionState.snapshot(stream.streamId)?.requestState === "response_closed") {
      await this.#sendStreamFrame(stream, WIPC_FRAME_TYPES.REQUEST_END, Buffer.alloc(0));
    }
  }

  #enqueueResponseChunk(stream: ActiveRemoteStream, payload: Buffer): void {
    stream.responseWriteTail = stream.responseWriteTail.then(async () => {
      if (stream.closed || stream.body.destroyed || stream.body.writableEnded) return;
      if (!stream.body.write(payload)) {
        await Promise.race([
          once(stream.body, "drain"),
          once(stream.body, "close")
        ]);
      }
      if (stream.closed || stream.body.destroyed) return;
      await this.#sendStreamFrame(
        stream,
        WIPC_FRAME_TYPES.WINDOW_UPDATE,
        encodeWipcWindowUpdate({ direction: "response", creditIncrement: payload.byteLength })
      );
    }).catch((error) => this.#failConnection(error));
  }

  #wakeRequestCredit(stream: ActiveRemoteStream): void {
    for (const resolve of stream.requestCreditWaiters) resolve();
    stream.requestCreditWaiters.clear();
  }

  #cancelRemoteStream(stream: ActiveRemoteStream, reason?: unknown): void {
    if (stream.closed || stream.controller.signal.aborted) return;
    const error = reason instanceof HelperStreamError
      ? reason
      : new HelperStreamError("cancelled", "Remote request was cancelled.");
    stream.controller.abort(error);
    stream.rejectResponse(error);
    if (stream.requestBody && !stream.requestBody.destroyed) stream.requestBody.destroy(error);
    if (!stream.body.destroyed) stream.body.destroy(error);
    this.#wakeRequestCredit(stream);
    void this.#sendStreamFrame(
      stream,
      WIPC_FRAME_TYPES.REQUEST_CANCEL,
      canonicalBytes({})
    ).catch((sendError) => this.#failConnection(sendError));
  }

  #enqueueRequestChunk(stream: ActiveHostStream, payload: Buffer): void {
    stream.requestWriteTail = stream.requestWriteTail.then(async () => {
      if (stream.closed || stream.body.destroyed || stream.body.writableEnded) return;
      if (!stream.body.write(payload)) {
        await Promise.race([
          once(stream.body, "drain"),
          once(stream.body, "close")
        ]);
      }
      if (stream.closed || stream.body.destroyed) return;
      await this.#sendStreamFrame(
        stream,
        WIPC_FRAME_TYPES.WINDOW_UPDATE,
        encodeWipcWindowUpdate({ direction: "request", creditIncrement: payload.byteLength })
      );
    }).catch((error) => this.#failConnection(error));
  }

  async #dispatchHostStream(stream: ActiveHostStream, requestStart: unknown): Promise<void> {
    try {
      if (!this.#bridgeConnection) {
        throw new HelperSupervisorError("helper_unavailable", "Authenticated request bridge is unavailable.");
      }
      const response = await this.#bridgeConnection.dispatch({
        streamId: stream.streamId,
        requestStart,
        body: stream.body,
        signal: stream.controller.signal
      });
      if (stream.closed || stream.controller.signal.aborted) {
        response.cancel(stream.controller.signal.reason);
        return;
      }
      stream.response = response;
      await this.#sendStreamFrame(stream, WIPC_FRAME_TYPES.RESPONSE_START, canonicalBytes({
        version: 1,
        statusCode: response.statusCode,
        statusMessage: response.statusMessage,
        headers: response.headers
      }));
      for await (const value of response.body) {
        const chunk = Buffer.from(value);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const available = await this.#waitForResponseCredit(stream);
          const size = Math.min(
            WIPC_DATA_PAYLOAD_MAX_BYTES,
            available,
            chunk.byteLength - offset
          );
          await this.#sendStreamFrame(
            stream,
            WIPC_FRAME_TYPES.RESPONSE_CHUNK,
            chunk.subarray(offset, offset + size)
          );
          offset += size;
        }
      }
      await this.#sendStreamFrame(stream, WIPC_FRAME_TYPES.RESPONSE_END, Buffer.alloc(0));
      this.#finishHostResponse(stream);
    } catch (error) {
      await this.#rejectHostStream(
        stream,
        stream.controller.signal.aborted ? "request_cancelled" : "request_failed",
        stream.controller.signal.aborted ? "request was cancelled" : "host request failed",
        error
      );
    }
  }

  async #waitForResponseCredit(stream: ActiveHostStream): Promise<number> {
    for (;;) {
      if (stream.closed || this.#closed || stream.controller.signal.aborted) {
        throw new Error("Helper response stream is closed.");
      }
      const snapshot = this.#connectionState.snapshot(stream.streamId);
      if (!snapshot) throw new Error("Helper response stream state is unavailable.");
      if (snapshot.responseCredit > 0) return snapshot.responseCredit;
      await new Promise<void>((resolve) => stream.responseCreditWaiters.add(resolve));
    }
  }

  #wakeResponseCredit(stream: ActiveHostStream): void {
    for (const resolve of stream.responseCreditWaiters) resolve();
    stream.responseCreditWaiters.clear();
  }

  async #sendStreamFrame(
    stream: ActiveStream,
    type: WipcFrameType,
    payload: Buffer
  ): Promise<void> {
    if (stream.closed || this.#closed) throw new Error("Helper stream is closed.");
    const transition = this.#connectionState.receive({
      sender: "node",
      frameType: type,
      streamId: stream.streamId,
      ...(type === WIPC_FRAME_TYPES.REQUEST_CHUNK || type === WIPC_FRAME_TYPES.RESPONSE_CHUNK
        ? { payloadLength: payload.byteLength }
        : {}),
      ...(type === WIPC_FRAME_TYPES.WINDOW_UPDATE
        ? { windowUpdate: decodeWipcWindowUpdate(payload) }
        : {})
    });
    if (transition.outcome === "stream_failed") {
      throw new Error("Node response violated WIPC stream state.");
    }
    if (!forwardWipcTransition(transition)) return;
    await writeFrame(this.#socket, type, payload, stream.streamId);
  }

  async #rejectHostStream(
    stream: ActiveHostStream,
    code: string,
    message: string,
    reason: unknown
  ): Promise<void> {
    if (stream.closed) return;
    stream.controller.abort(reason);
    stream.response?.cancel(reason);
    const snapshot = this.#connectionState.snapshot(stream.streamId);
    if (snapshot && !snapshot.protocolFailed && !["succeeded", "failed"].includes(snapshot.responseState)) {
      try {
        await this.#sendStreamFrame(
          stream,
          WIPC_FRAME_TYPES.RESPONSE_ERROR,
          boundedStreamError(code, message)
        );
      } catch (error) {
        this.#failConnection(error);
      }
    }
    this.#finishHostResponse(stream, reason);
  }

  #finishHostResponse(stream: ActiveHostStream, reason?: unknown): void {
    if (stream.closed) return;
    stream.response = undefined;
    const snapshot = this.#connectionState.snapshot(stream.streamId);
    if (snapshot?.requestState === "response_closed") {
      if (!stream.body.destroyed) {
        stream.body.destroy(
          reason instanceof Error ? reason : new Error("Host response closed the request upload.")
        );
      }
      this.#wakeResponseCredit(stream);
      return;
    }
    this.#removeStream(stream.streamId, reason);
  }

  #cancelHostStream(stream: ActiveHostStream, reason: Error): void {
    if (stream.closed) return;
    stream.controller.abort(reason);
    stream.response?.cancel(reason);
    if (!stream.body.destroyed) stream.body.destroy(reason);
    this.#wakeResponseCredit(stream);
  }

  #removeStream(streamId: bigint, reason?: unknown, preserveBody = false): void {
    const stream = this.#streams.get(streamId);
    if (!stream) {
      try {
        this.#connectionState.removeStream(streamId);
      } catch {
        // The high-water mark still contains rejected streams that were never active.
      }
      return;
    }
    stream.closed = true;
    this.#streams.delete(streamId);
    if (stream.kind === "host") {
      this.#wakeResponseCredit(stream);
    } else {
      stream.removeExternalAbort();
      this.#wakeRequestCredit(stream);
    }
    if (reason !== undefined) {
      stream.controller.abort(reason);
      if (stream.kind === "host") stream.response?.cancel(reason);
      else {
        stream.rejectResponse(reason instanceof Error ? reason : new Error("Remote request failed."));
        if (stream.requestBody && !stream.requestBody.destroyed) {
          stream.requestBody.destroy(reason instanceof Error ? reason : undefined);
        }
      }
    }
    if (!preserveBody && !stream.body.destroyed && !stream.body.readableEnded) {
      stream.body.destroy(reason instanceof Error ? reason : undefined);
    }
    try {
      this.#connectionState.removeStream(streamId);
    } catch {
      // Connection teardown owns nonterminal streams; no later frame is accepted.
    }
  }

  #failConnection(reason: unknown): void {
    if (this.#closed || this.#terminalError) return;
    const error = reason instanceof Error
      ? reason
      : new HelperSupervisorError("helper_unavailable", "Helper session failed.");
    this.#terminalError = error;
    this.#pendingCommand?.reject(error);
    this.#pendingCommand = undefined;
    for (const streamId of [...this.#streams.keys()]) this.#removeStream(streamId, error);
    this.#bridgeConnection?.close(error);
    this.#bridgeConnection = undefined;
    this.#authentication.close();
    this.#socket.destroy();
    this.#publishStatus({
      ...this.#status,
      controlState: "unavailable",
      directState: this.#status.directState === "direct" ? "direct" : "direct_unavailable",
      lastErrorCode: "helper_unavailable"
    });
  }

  async identityStatus(): Promise<HelperIdentityStatus> {
    const result = await this.#command({
      command: "identity_status",
      dataRoot: this.#dataRoot,
      role: this.#role
    }, IdentityStatusWireSchema, "identity status RESULT");
    const status = HelperIdentityStatusSchema.parse({
      activationState: result.activationState,
      deviceId: result.deviceId,
      installationFingerprint: result.installationFingerprint,
      secretStorage: result.secretStorage
    });
    this.#publishStatus({
      ...this.#status,
      activationState: status.activationState
    });
    return status;
  }

  async beginActivation(operationId: string): Promise<HelperActivationStart> {
    const result = await this.#command({
      command: "activation_begin",
      dataRoot: this.#dataRoot,
      operationId: Base64Url32BytesSchema.parse(operationId),
      role: this.#role
    }, ActivationBeginWireSchema, "activation begin RESULT");
    return HelperActivationStartSchema.parse({
      operationId: result.operationId,
      verificationUrl: result.verificationUrl,
      expiresAt: result.expiresAt
    });
  }

  async pollActivation(operationId: string): Promise<HelperActivationPoll> {
    const result = await this.#command({
      command: "activation_poll",
      operationId: Base64Url32BytesSchema.parse(operationId)
    }, ActivationPollWireSchema, "activation poll RESULT");
    return HelperActivationPollSchema.parse({
      operationId: result.operationId,
      state: result.state,
      expiresAt: result.expiresAt,
      ...(result.state === "failed" ? { errorCode: result.errorCode } : {})
    });
  }

  async cancelActivation(operationId: string): Promise<HelperActivationCancel> {
    const result = await this.#command({
      command: "activation_cancel",
      operationId: Base64Url32BytesSchema.parse(operationId)
    }, ActivationCancelWireSchema, "activation cancel RESULT");
    return HelperActivationCancelSchema.parse({
      operationId: result.operationId,
      cancelled: result.cancelled
    });
  }

  async startRuntime(selectedPairId?: string): Promise<HelperRuntimeStatus> {
    const selection = selectedPairId === undefined
      ? undefined
      : Base64Url16BytesSchema.parse(selectedPairId);
    if (this.#role === "host" && selection !== undefined) {
      throw new HelperSupervisorError("helper_incompatible", "Host runtime cannot select a remote pair.");
    }
    if (this.#role === "remote" && selection === undefined) {
      throw new HelperSupervisorError("helper_incompatible", "Remote runtime requires one selected host.");
    }
    const result = await this.#command({
      command: "runtime_start",
      dataRoot: this.#dataRoot,
      role: this.#role,
      ...(selection ? { selectedPairId: selection } : {})
    }, RuntimeStatusWireSchema, "runtime start RESULT");
    return this.#publishStatus({
      activationState: result.activationState,
      controlState: result.controlState,
      directState: result.directState,
      lastDirectAt: result.lastDirectAt,
      lastErrorCode: result.lastErrorCode
    });
  }

  async runtimeStatus(): Promise<HelperRuntimeStatus> {
    return this.#runtimeStatusCommand("runtime_status");
  }

  async reconnectRuntime(): Promise<HelperRuntimeStatus> {
    return this.#runtimeStatusCommand("runtime_reconnect");
  }

  async stopRuntime(): Promise<HelperRuntimeStatus> {
    return this.#runtimeStatusCommand("runtime_stop");
  }

  async #runtimeStatusCommand(
    command: "runtime_status" | "runtime_reconnect" | "runtime_stop"
  ): Promise<HelperRuntimeStatus> {
    const result = await this.#command({ command }, RuntimeStatusWireSchema, `${command} RESULT`);
    return this.#publishStatus({
      activationState: result.activationState,
      controlState: result.controlState,
      directState: result.directState,
      lastDirectAt: result.lastDirectAt,
      lastErrorCode: result.lastErrorCode
    });
  }

  async registerGatewayLaunch(gatewayLaunchId: string, expiresAt: string): Promise<void> {
    await this.#command({
      command: "register_gateway_launch",
      gatewayLaunchId: Base64Url32BytesSchema.parse(gatewayLaunchId),
      expiresAt: Uint64DecimalSchema.parse(expiresAt)
    }, RegisterGatewayLaunchWireSchema, "register gateway launch RESULT");
  }

  async createInvitation(
    actorValue: HelperConfirmedAdminActor,
    idempotencyKeyValue: string
  ): Promise<PairInvitationV1> {
    this.#requireHostManagement();
    const result = await this.#command({
      command: "invitation_create",
      actor: HelperConfirmedAdminActorSchema.parse(actorValue),
      idempotencyKey: Base64Url32BytesSchema.parse(idempotencyKeyValue)
    }, InvitationCreateWireSchema, "invitation create RESULT");
    return PairInvitationV1Schema.parse({
      invitationId: result.invitationId,
      fullToken: result.fullToken,
      shortCode: result.shortCode,
      expiresAt: result.expiresAt
    });
  }

  async cancelInvitation(
    invitationIdValue: string,
    actorValue: HelperConfirmedAdminActor
  ): Promise<void> {
    this.#requireHostManagement();
    await this.#command({
      command: "invitation_cancel",
      invitationId: Base64Url16BytesSchema.parse(invitationIdValue),
      actor: HelperConfirmedAdminActorSchema.parse(actorValue)
    }, InvitationCancelWireSchema, "invitation cancel RESULT");
  }

  async listPairingRequests(
    actorValue: HelperRequestActor
  ): Promise<PendingPairingRequestListV1> {
    this.#requireHostManagement();
    const result = await this.#command({
      command: "pairing_requests_list",
      actor: HelperRequestActorSchema.parse(actorValue)
    }, PairingRequestsListWireSchema, "pairing requests list RESULT");
    return PendingPairingRequestListV1Schema.parse({
      version: result.version,
      requests: result.requests
    });
  }

  async approvePairingRequest(
    requestIdValue: string,
    inputValue: ApprovePairingInputV1,
    actorValue: HelperConfirmedAdminActor
  ): Promise<void> {
    this.#requireHostManagement();
    await this.#command({
      command: "pairing_request_approve",
      requestId: Base64Url16BytesSchema.parse(requestIdValue),
      input: ApprovePairingInputV1Schema.parse(inputValue),
      actor: HelperConfirmedAdminActorSchema.parse(actorValue)
    }, PairingRequestApproveWireSchema, "pairing request approve RESULT");
  }

  async rejectPairingRequest(
    requestIdValue: string,
    actorValue: HelperRequestActor
  ): Promise<void> {
    this.#requireHostManagement();
    await this.#command({
      command: "pairing_request_reject",
      requestId: Base64Url16BytesSchema.parse(requestIdValue),
      actor: HelperRequestActorSchema.parse(actorValue)
    }, PairingRequestRejectWireSchema, "pairing request reject RESULT");
  }

  async listDevices(): Promise<TrustedDeviceListV1> {
    this.#requireHostManagement();
    const result = await this.#command(
      { command: "trusted_devices_list" },
      TrustedDevicesListWireSchema,
      "trusted devices list RESULT"
    );
    return TrustedDeviceListV1Schema.parse({
      version: result.version,
      devices: result.devices
    });
  }

  async renameDevice(
    deviceIdValue: string,
    inputValue: RenameTrustedDeviceInputV1,
    actorValue: HelperRequestActor
  ): Promise<TrustedDeviceSummaryV1> {
    this.#requireHostManagement();
    const deviceId = DeviceIdSchema.parse(deviceIdValue);
    const result = await this.#command({
      command: "trusted_device_rename",
      deviceId,
      input: RenameTrustedDeviceInputV1Schema.parse(inputValue),
      actor: HelperRequestActorSchema.parse(actorValue)
    }, TrustedDeviceRenameWireSchema, "trusted device rename RESULT");
    return TrustedDeviceSummaryV1Schema.parse({
      version: result.version,
      deviceId: result.deviceId,
      displayName: result.displayName,
      platform: result.platform,
      installationFingerprint: result.installationFingerprint,
      trustEpoch: result.trustEpoch,
      revision: result.revision,
      pairedAt: result.pairedAt,
      lastSeenAt: result.lastSeenAt,
      connectionState: result.connectionState
    });
  }

  async revokeDevice(
    deviceIdValue: string,
    actorValue: HelperConfirmedAdminActor
  ): Promise<void> {
    this.#requireHostManagement();
    await this.#command({
      command: "trusted_device_revoke",
      deviceId: DeviceIdSchema.parse(deviceIdValue),
      actor: HelperConfirmedAdminActorSchema.parse(actorValue)
    }, TrustedDeviceRevokeWireSchema, "trusted device revoke RESULT");
  }

  #requireHostManagement(): void {
    if (this.#role !== "host") {
      throw new HelperSupervisorError(
        "helper_incompatible",
        "Pairing and trusted-device management require a host-role helper."
      );
    }
  }

  async #command<T extends {
    command: string;
    ok: true;
    operationId?: string;
    invitationId?: string;
    requestId?: string;
    deviceId?: string;
  }>(
    command: {
      command: string;
      operationId?: string;
      invitationId?: string;
      requestId?: string;
      deviceId?: string;
    } & Record<string, unknown>,
    schema: z.ZodType<T>,
    label: string
  ): Promise<T> {
    let release!: () => void;
    const prior = this.#commandTail;
    this.#commandTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      if (this.#closed || this.#socket.destroyed || this.#terminalError) {
        throw new HelperCommandError("helper_unavailable", "Helper command channel is closed.");
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let resolveFrame!: (frame: WipcFrame) => void;
      let rejectFrame!: (error: Error) => void;
      const exchange = new Promise<WipcFrame>((resolve, reject) => {
        resolveFrame = resolve;
        rejectFrame = reject;
      });
      const pending: PendingCommand = { resolve: resolveFrame, reject: rejectFrame };
      if (this.#pendingCommand) {
        throw new HelperSupervisorError("helper_incompatible", "A helper command is already pending.");
      }
      this.#pendingCommand = pending;
      try {
        await writeFrame(this.#socket, WIPC_FRAME_TYPES.COMMAND, canonicalBytes(command));
      } catch (error) {
        if (this.#pendingCommand === pending) this.#pendingCommand = undefined;
        throw error;
      }
      const frame = await Promise.race([
        exchange,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            const error = new HelperCommandError(
              "helper_unavailable",
              "Helper command deadline expired."
            );
            this.#failConnection(error);
            reject(error);
          }, HELPER_COMMAND_TIMEOUT_MS);
        })
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
        if (this.#pendingCommand === pending) this.#pendingCommand = undefined;
      });
      requireFrame(frame, WIPC_FRAME_TYPES.RESULT, "RESULT");
      const failure = (() => {
        try {
          return parseCanonical(frame.payload, HelperCommandFailureSchema, label);
        } catch {
          return undefined;
        }
      })();
      if (failure) {
        if (!commandResultMatches(failure, command)) {
          throw new HelperSupervisorError(
            "helper_incompatible",
            "Helper command failure did not match the request."
          );
        }
        const activationCommand = command.command === "identity_status"
          || command.command.startsWith("activation_");
        if (activationCommand) {
          const code = HelperActivationErrorCodeSchema.safeParse(failure.errorCode);
          if (!code.success) {
            throw new HelperSupervisorError(
              "helper_incompatible",
              "Helper returned an invalid activation failure code."
            );
          }
          throw new HelperCommandError(code.data, "Helper rejected the activation command.");
        }
        const code = RemoteAccessErrorCodeSchema.safeParse(failure.errorCode);
        if (!code.success) {
          throw new HelperSupervisorError(
            "helper_incompatible",
            "Helper returned an invalid runtime failure code."
          );
        }
        throw new HelperSupervisorError(code.data, "Helper rejected the runtime command.");
      }
      const result = parseCanonical(frame.payload, schema, label);
      if (!commandResultMatches(result, command)) {
        throw new HelperSupervisorError(
          "helper_incompatible",
          "Helper command result did not match the request."
        );
      }
      return result;
    } catch (error) {
      if (error instanceof HelperCommandError || error instanceof HelperSupervisorError) throw error;
      throw new HelperCommandError("helper_unavailable", "Helper command channel failed.");
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const error = new Error("Helper client is closing.");
    this.#pendingCommand?.reject(error);
    this.#pendingCommand = undefined;
    for (const streamId of [...this.#streams.keys()]) this.#removeStream(streamId, error);
    this.#bridgeConnection?.close(error);
    this.#bridgeConnection = undefined;
    this.#authentication.close();
    this.#statusListeners.clear();
    this.#socket.destroy();
  }
}

async function authenticateSocket(
  socket: Socket,
  parentHelloInput: ComponentHello,
  parentCapability: Buffer,
  dataRoot: string,
  role: "host" | "remote"
): Promise<ProcessHelperClient> {
  let authentication: WipcParentAuthSession | undefined;
  try {
    const parentHello = ComponentHelloSchema.parse(parentHelloInput);
    const helloBytes = canonicalBytes(parentHello);
    const clientNonce = Buffer.from(parentHello.nonce, "base64url");
    authentication = new WipcParentAuthSession({
      parentCapability,
      clientNonce,
      helloBytes
    });
    await writeFrame(socket, WIPC_FRAME_TYPES.HELLO, helloBytes);
    const helloAckFrame = await readFrame(socket);
    requireFrame(helloAckFrame, WIPC_FRAME_TYPES.HELLO_ACK, "HELLO_ACK");
    const helperHello = parseCanonical(
      helloAckFrame.payload,
      ComponentHelloSchema,
      "Helper HELLO_ACK"
    );
    if (helperHello.component !== "ts_connect") {
      throw new HelperSupervisorError("helper_incompatible", "Helper HELLO_ACK has the wrong component.");
    }
    const compatibility = negotiateComponentCompatibility(parentHello, helperHello);
    if (!compatibility.compatible) {
      throw new HelperSupervisorError("helper_incompatible", compatibility.message);
    }
    const helperNonce = Buffer.from(helperHello.nonce, "base64url");
    const parentProof = authentication.beginCandidate({
      helperNonce,
      helloAckBytes: helloAckFrame.payload
    });
    try {
      await writeFrame(socket, WIPC_FRAME_TYPES.COMMAND, canonicalBytes({
        command: "authenticate_parent",
        parentProof: parentProof.toString("base64url")
      }));
    } finally {
      parentProof.fill(0);
    }
    const resultFrame = await readFrame(socket);
    requireFrame(resultFrame, WIPC_FRAME_TYPES.RESULT, "RESULT");
    const result = parseCanonical(
      resultFrame.payload,
      AuthenticateParentResultSchema,
      "Helper authentication RESULT"
    );
    const helperProof = Buffer.from(result.helperProof, "base64url");
    try {
      authentication.completeCandidate(helperProof);
    } finally {
      helperProof.fill(0);
    }
    authentication.assertTrafficAllowed();
    return new ProcessHelperClient(
      socket,
      helperHello,
      compatibility.protocol,
      compatibility.capabilities,
      dataRoot,
      role,
      authentication
    );
  } catch (error) {
    authentication?.close();
    throw error;
  }
}

function stopListening(server: net.Server): void {
  if (server.listening) server.close();
}

function processExit(child: ChildProcess): {
  promise: Promise<HelperProcessExit>;
  settleError: () => void;
} {
  let settled = false;
  let resolveExit!: (exit: HelperProcessExit) => void;
  const promise = new Promise<HelperProcessExit>((resolve) => {
    resolveExit = resolve;
  });
  child.once("exit", (code, signal) => {
    if (settled) return;
    settled = true;
    resolveExit({ code, signal });
  });
  return {
    promise,
    settleError: () => {
      if (settled) return;
      settled = true;
      resolveExit({ code: null, signal: null });
    }
  };
}

export class ProtectedHelperProcessFactory implements HelperProcessFactory {
  async launch(request: HelperLaunchRequest): Promise<HelperLaunch> {
    if (process.platform === "win32") {
      request.parentCapability.fill(0);
      throw new HelperSupervisorError(
        "unsupported_platform",
        "A current-user-only Windows named-pipe launcher is not installed."
      );
    }
    await validateUnixRuntimeDirectory(request.parentEndpoint);
    const capability = Buffer.from(request.parentCapability);
    request.parentCapability.fill(0);
    if (capability.byteLength !== 32) {
      capability.fill(0);
      throw new HelperSupervisorError("helper_unavailable", "Parent capability has invalid width.");
    }

    const server = net.createServer();
    const sockets = new Set<Socket>();
    let authenticatedClient: ProcessHelperClient | undefined;
    let authenticationSettled = false;
    let resolveAuthentication!: (client: AuthenticatedHelperClient) => void;
    let rejectAuthentication!: (error: Error) => void;
    const authenticated = new Promise<AuthenticatedHelperClient>((resolve, reject) => {
      resolveAuthentication = resolve;
      rejectAuthentication = reject;
    });
    const rejectLaunchAuthentication = (error: Error) => {
      if (authenticationSettled) return;
      authenticationSettled = true;
      capability.fill(0);
      rejectAuthentication(error);
    };

    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      if (authenticationSettled) {
        socket.destroy();
        return;
      }
      void authenticateSocket(
        socket,
        request.parentHello,
        capability,
        request.dataRoot,
        request.role
      ).then((client) => {
        if (authenticationSettled) {
          void client.close();
          return;
        }
        authenticationSettled = true;
        authenticatedClient = client;
        capability.fill(0);
        stopListening(server);
        for (const candidate of sockets) {
          if (candidate !== socket) candidate.destroy();
        }
        resolveAuthentication(client);
      }).catch(() => {
        socket.destroy();
      });
    });

    try {
      await listenProtectedUnix(server, request.parentEndpoint);
    } catch (error) {
      capability.fill(0);
      stopListening(server);
      throw new HelperSupervisorError(
        "helper_unavailable",
        error instanceof Error ? error.message : "Protected parent listener failed."
      );
    }
    server.on("error", () => {
      rejectLaunchAuthentication(new HelperSupervisorError(
        "helper_unavailable",
        "Protected parent listener failed after startup."
      ));
      for (const socket of sockets) socket.destroy();
    });

    let child: ChildProcess;
    try {
      child = spawn(request.binaryPath, [...request.argv], {
        env: { ...request.environment },
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe", "pipe"]
      });
    } catch (error) {
      capability.fill(0);
      stopListening(server);
      throw new HelperSupervisorError(
        "helper_unavailable",
        error instanceof Error ? error.message : "Protected helper spawn failed."
      );
    }
    child.stderr?.resume();
    const capabilityPipe = child.stdio[3];
    if (!capabilityPipe || typeof (capabilityPipe as NodeJS.WritableStream).write !== "function") {
      child.kill("SIGKILL");
      capability.fill(0);
      stopListening(server);
      throw new HelperSupervisorError("helper_unavailable", "Inherited capability pipe is unavailable.");
    }
    const writableCapabilityPipe = capabilityPipe as NodeJS.WritableStream;
    let parentChannelClosed = false;
    const closeParentCapabilityChannel = () => {
      if (parentChannelClosed) return;
      parentChannelClosed = true;
      capability.fill(0);
      writableCapabilityPipe.end();
    };
    const pipeCopy = Buffer.from(capability);
    writableCapabilityPipe.write(pipeCopy, (error?: Error | null) => {
      pipeCopy.fill(0);
      if (error) rejectLaunchAuthentication(new HelperSupervisorError(
        "helper_unavailable",
        "Writing the inherited helper capability failed."
      ));
    });

    const exit = processExit(child);
    child.once("error", () => {
      exit.settleError();
      rejectLaunchAuthentication(new HelperSupervisorError(
        "helper_unavailable",
        "Protected helper process could not start."
      ));
    });
    void exit.promise.then(() => {
      stopListening(server);
      for (const socket of sockets) socket.destroy();
      rejectLaunchAuthentication(new HelperSupervisorError(
        "helper_unavailable",
        "Helper exited before mutual authentication completed."
      ));
    });

    return {
      authenticated,
      exited: exit.promise,
      requestDrain: async () => {
        await authenticatedClient?.close();
        closeParentCapabilityChannel();
        stopListening(server);
        for (const socket of sockets) socket.destroy();
      },
      closeParentChannel: () => {
        closeParentCapabilityChannel();
        stopListening(server);
      },
      forceTerminate: () => {
        child.kill("SIGKILL");
      }
    };
  }
}
