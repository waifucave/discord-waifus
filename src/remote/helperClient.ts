import { spawn, type ChildProcess } from "node:child_process";
import { lstat, chmod } from "node:fs/promises";
import net, { type Socket } from "node:net";
import path from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";
import {
  Base64Url32BytesSchema,
  ComponentHelloSchema,
  negotiateComponentCompatibility,
  type ComponentHello,
  type ProtocolVersion
} from "../shared/schemas/remoteProtocol.js";
import {
  serializeCanonicalContractJson,
  type ContractJson
} from "../shared/schemas/remoteProtocolContract.js";
import {
  WIPC_FRAME_TYPES,
  WIPC_HEADER_BYTES,
  WIPC_PROTOCOL_VERSION,
  decodeWipcHeader,
  encodeWipcHeader,
  type WipcFrameType
} from "../shared/wipc.js";
import { WipcParentAuthSession } from "../shared/wipcAuthSession.js";
import {
  HelperSupervisorError,
  HELPER_COMMAND_TIMEOUT_MS,
  HelperCommandError,
  HelperActivationCancelSchema,
  HelperActivationErrorCodeSchema,
  HelperActivationPollSchema,
  HelperActivationStartSchema,
  HelperIdentityStatusSchema,
  parseHelperRuntimeStatus,
  type AuthenticatedHelperClient,
  type HelperActivationCancel,
  type HelperActivationPoll,
  type HelperActivationStart,
  type HelperIdentityStatus,
  type HelperLaunch,
  type HelperLaunchRequest,
  type HelperProcessExit,
  type HelperProcessFactory,
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
    "identity_status"
  ]),
  errorCode: HelperActivationErrorCodeSchema,
  ok: z.literal(false),
  operationId: Base64Url32BytesSchema.optional()
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

type WipcFrame = {
  readonly type: WipcFrameType;
  readonly payload: Buffer;
};

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(serializeCanonicalContractJson(value as ContractJson), "utf8");
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
    const chunk = socket.read(size - offset) as Buffer | null;
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
    payload: await readExactly(socket, header.payloadLength)
  };
}

async function writeFrame(socket: Socket, type: WipcFrameType, payload: Buffer): Promise<void> {
  const header = encodeWipcHeader({
    ...WIPC_PROTOCOL_VERSION,
    frameType: type,
    flags: 0,
    streamId: 0n,
    payloadLength: payload.byteLength
  });
  const encoded = Buffer.concat([header, payload]);
  await new Promise<void>((resolve, reject) => {
    socket.write(encoded, (error) => error ? reject(error) : resolve());
  });
}

function requireFrame(frame: WipcFrame, expected: WipcFrameType, label: string): void {
  if (frame.type !== expected) {
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

class ProcessHelperClient implements AuthenticatedHelperClient {
  readonly hello: ComponentHello;
  readonly negotiatedProtocol: ProtocolVersion;
  readonly negotiatedCapabilities: readonly string[];
  readonly #socket: Socket;
  #status: HelperRuntimeStatus;
  readonly #dataRoot: string;
  readonly #role: "host" | "remote";
  #commandTail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(
    socket: Socket,
    hello: ComponentHello,
    negotiatedProtocol: ProtocolVersion,
    negotiatedCapabilities: readonly string[],
    dataRoot: string,
    role: "host" | "remote"
  ) {
    this.#socket = socket;
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
  }

  currentStatus(): HelperRuntimeStatus {
    return this.#status;
  }

  subscribeStatus(): () => void {
    return () => {};
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
    this.#status = Object.freeze(parseHelperRuntimeStatus({
      ...this.#status,
      activationState: status.activationState
    }));
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

  async #command<T extends { command: string; ok: true; operationId?: string }>(
    command: { command: string; operationId?: string } & Record<string, unknown>,
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
      if (this.#closed || this.#socket.destroyed) {
        throw new HelperCommandError("helper_unavailable", "Helper command channel is closed.");
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const exchange = (async () => {
        await writeFrame(this.#socket, WIPC_FRAME_TYPES.COMMAND, canonicalBytes(command));
        return readFrame(this.#socket);
      })();
      const frame = await Promise.race([
        exchange,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            this.#socket.destroy();
            reject(new HelperCommandError(
              "helper_unavailable",
              "Helper command deadline expired."
            ));
          }, HELPER_COMMAND_TIMEOUT_MS);
        })
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
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
        if (
          failure.command !== command.command
          || failure.operationId !== command.operationId
        ) {
          throw new HelperSupervisorError(
            "helper_incompatible",
            "Helper command failure did not match the request."
          );
        }
        throw new HelperCommandError(failure.errorCode, "Helper rejected the activation command.");
      }
      const result = parseCanonical(frame.payload, schema, label);
      if (
        result.command !== command.command
        || result.operationId !== command.operationId
      ) {
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
    this.#closed = true;
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
      role
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
