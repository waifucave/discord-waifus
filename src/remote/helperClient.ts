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
  parseHelperRuntimeStatus,
  type AuthenticatedHelperClient,
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
    throw new HelperSupervisorError("helper_incompatible", `Expected ${label} during helper authentication.`);
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
  readonly #status: HelperRuntimeStatus;

  constructor(
    socket: Socket,
    hello: ComponentHello,
    negotiatedProtocol: ProtocolVersion,
    negotiatedCapabilities: readonly string[]
  ) {
    this.#socket = socket;
    this.hello = Object.freeze(hello);
    this.negotiatedProtocol = Object.freeze(negotiatedProtocol);
    this.negotiatedCapabilities = Object.freeze([...negotiatedCapabilities]);
    this.#status = Object.freeze(parseHelperRuntimeStatus({
      activationState: "active",
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

  async close(): Promise<void> {
    this.#socket.destroy();
  }
}

async function authenticateSocket(
  socket: Socket,
  parentHelloInput: ComponentHello,
  parentCapability: Buffer
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
      compatibility.capabilities
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
      void authenticateSocket(socket, request.parentHello, capability).then((client) => {
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
