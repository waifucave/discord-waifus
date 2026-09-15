import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import net from "node:net";

const HEADER_BYTES = 24;
const HELLO = 0x01;
const HELLO_ACK = 0x02;
const COMMAND = 0x03;
const RESULT = 0x04;
const REQUEST_START = 0x10;
const REQUEST_CHUNK = 0x11;
const REQUEST_END = 0x12;
const REQUEST_CANCEL = 0x13;
const RESPONSE_START = 0x20;
const RESPONSE_CHUNK = 0x21;
const RESPONSE_END = 0x22;
const RESPONSE_ERROR = 0x23;
const WINDOW_UPDATE = 0x30;
const REQUIRED_CAPABILITIES = [
  "waifus.browser-context.v1",
  "waifus.dashboard.manifest.v1",
  "waifus.http.v1",
  "waifus.principal.v1",
  "waifus.sse.cursor.v1",
  "waifus.stream.cancel.v1"
];

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, sortJson(child)])
  );
}

function canonicalJson(value) {
  return Buffer.from(JSON.stringify(sortJson(value)));
}

async function writeResult(resultPath, value) {
  const stagingPath = `${resultPath}.${process.pid}.tmp`;
  await writeFile(stagingPath, JSON.stringify(value));
  await rename(stagingPath, resultPath);
}

function frame(type, payload, streamId = 0n) {
  const header = Buffer.alloc(HEADER_BYTES);
  header.write("WIPC", 0, "ascii");
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(0, 6);
  header.writeUInt8(type, 8);
  header.writeBigUInt64BE(streamId, 12);
  header.writeUInt32BE(payload.byteLength, 20);
  return Buffer.concat([header, payload]);
}

function frameReader(socket) {
  let buffered = Buffer.alloc(0);
  const waiting = [];
  const flush = () => {
    while (waiting.length > 0 && buffered.byteLength >= waiting[0].size) {
      const next = waiting.shift();
      const value = buffered.subarray(0, next.size);
      buffered = buffered.subarray(next.size);
      next.resolve(value);
    }
  };
  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    flush();
  });
  socket.on("error", (error) => {
    for (const next of waiting.splice(0)) next.reject(error);
  });
  socket.on("close", () => {
    for (const next of waiting.splice(0)) next.reject(new Error("socket closed"));
  });
  return async () => {
    const header = await new Promise((resolve, reject) => {
      waiting.push({ size: HEADER_BYTES, resolve, reject });
      flush();
    });
    if (header.subarray(0, 4).toString("ascii") !== "WIPC") throw new Error("bad header");
    const size = header.readUInt32BE(20);
    const payload = await new Promise((resolve, reject) => {
      waiting.push({ size, resolve, reject });
      flush();
    });
    return { type: header.readUInt8(8), streamId: header.readBigUInt64BE(12), payload };
  };
}

function proof(domain, capability, clientNonce, helperNonce, hello, helloAck, parentProof) {
  const hmac = createHmac("sha256", capability)
    .update(domain)
    .update(clientNonce)
    .update(helperNonce)
    .update(hello)
    .update(helloAck);
  if (parentProof) hmac.update(parentProof);
  return hmac.digest();
}

async function runRequestProbe(socket, readFrame) {
  const resultPath = process.env.FAKE_HELPER_RESULT_PATH;
  if (!resultPath) throw new Error("missing request probe result path");
  const bytes16 = (value) => Buffer.alloc(16, value).toString("base64url");
  socket.write(frame(REQUEST_START, canonicalJson({
    version: 1,
    method: "GET",
    canonicalTarget: "/probe?source=helper",
    headers: [["x-probe", "present"]],
    principal: {
      kind: "remote_device",
      stableId: "remote:fixture-device",
      deviceId: "fixture-device",
      peerFingerprint: bytes16(0x21),
      transportSessionId: bytes16(0x22),
      trustEpoch: "7"
    }
  }), 2n));
  const delayedRequestEnd = process.env.FAKE_HELPER_DELAY_REQUEST_END_UNTIL_RESPONSE === "1";
  if (!delayedRequestEnd) socket.write(frame(REQUEST_END, Buffer.alloc(0), 2n));

  let responseStart;
  const chunks = [];
  let pendingRuntimeStatus = false;
  for (;;) {
    const incoming = await readFrame();
    if (incoming.streamId === 0n && incoming.type === COMMAND) {
      const command = JSON.parse(incoming.payload.toString("utf8"));
      if (command.command !== "runtime_status" || pendingRuntimeStatus) {
        throw new Error("unexpected concurrent probe command");
      }
      pendingRuntimeStatus = true;
      continue;
    }
    if (incoming.streamId !== 2n) throw new Error("unexpected probe stream");
    if (incoming.type === RESPONSE_START) {
      responseStart = JSON.parse(incoming.payload.toString("utf8"));
      continue;
    }
    if (incoming.type === RESPONSE_CHUNK) {
      chunks.push(incoming.payload);
      const update = Buffer.alloc(8);
      update.writeUInt8(2, 0);
      update.writeUInt32BE(incoming.payload.byteLength, 4);
      socket.write(frame(WINDOW_UPDATE, update, 2n));
      continue;
    }
    if (incoming.type === RESPONSE_ERROR) {
      throw new Error(`probe failed: ${incoming.payload.toString("utf8")}`);
    }
    if (incoming.type === RESPONSE_END) {
      if (delayedRequestEnd) socket.write(frame(REQUEST_END, Buffer.alloc(0), 2n));
      break;
    }
    throw new Error("unexpected probe response frame");
  }
  await writeResult(resultPath, {
    responseStart,
    body: Buffer.concat(chunks).toString("utf8")
  });
  if (pendingRuntimeStatus) {
    socket.write(frame(RESULT, canonicalJson({
      activationState: "active",
      command: "runtime_status",
      controlState: "connected",
      directState: "reconnecting",
      lastDirectAt: null,
      lastErrorCode: null,
      ok: true
    })));
  }
}

async function runRemoteRequestProbe(socket, readFrame, startFrame) {
  const resultPath = process.env.FAKE_HELPER_RESULT_PATH;
  if (!resultPath) throw new Error("missing remote request probe result path");
  if (startFrame.streamId !== 1n) throw new Error("expected first Node-created stream");
  const requestStart = JSON.parse(startFrame.payload.toString("utf8"));
  const chunks = [];
  let cancelled = false;
  let requestEnded = false;
  let earlyResponseSent = false;
  for (;;) {
    const incoming = await readFrame();
    if (incoming.streamId !== startFrame.streamId) throw new Error("unexpected remote request stream");
    if (incoming.type === REQUEST_CHUNK) {
      chunks.push(incoming.payload);
      if (process.env.FAKE_HELPER_REMOTE_EARLY_RESPONSE === "1" && !earlyResponseSent) {
        earlyResponseSent = true;
        socket.write(frame(RESPONSE_START, canonicalJson({
          version: 1,
          statusCode: 413,
          statusMessage: "Payload Too Large",
          headers: [["content-length", "0"]]
        }), startFrame.streamId));
        socket.write(frame(RESPONSE_END, Buffer.alloc(0), startFrame.streamId));
        continue;
      }
      if (earlyResponseSent) continue;
      const update = Buffer.alloc(8);
      update.writeUInt8(1, 0);
      update.writeUInt32BE(incoming.payload.byteLength, 4);
      socket.write(frame(WINDOW_UPDATE, update, startFrame.streamId));
      continue;
    }
    if (incoming.type === REQUEST_CANCEL) {
      cancelled = true;
      break;
    }
    if (incoming.type === REQUEST_END) {
      requestEnded = true;
      if (process.env.FAKE_HELPER_REMOTE_WAIT_FOR_CANCEL === "1") continue;
      break;
    }
    throw new Error("unexpected remote request frame");
  }

  const requestBody = Buffer.concat(chunks);
  const result = {
    streamId: startFrame.streamId.toString(10),
    requestStart,
    cancelled,
    requestEnded
  };
  if (process.env.FAKE_HELPER_RESULT_BODY_MODE === "digest") {
    result.bodyBytes = requestBody.byteLength;
    result.bodySha256 = createHash("sha256").update(requestBody).digest("hex");
  } else {
    result.body = requestBody.toString("utf8");
  }
  if (earlyResponseSent) {
    result.bodyBytes = requestBody.byteLength;
    await writeResult(resultPath, result);
    return;
  }
  if (cancelled) {
    await writeResult(resultPath, result);
    socket.write(frame(RESPONSE_ERROR, canonicalJson({
      code: "cancelled",
      message: "request cancelled"
    }), startFrame.streamId));
    return;
  }
  if (process.env.FAKE_HELPER_REMOTE_RESPONSE_ERROR) {
    await writeResult(resultPath, result);
    socket.write(frame(RESPONSE_ERROR, canonicalJson({
      code: process.env.FAKE_HELPER_REMOTE_RESPONSE_ERROR,
      message: "direct connection unavailable"
    }), startFrame.streamId));
    return;
  }
  if (process.env.FAKE_HELPER_REMOTE_PROTOCOL_ERROR === "1") {
    await writeResult(resultPath, result);
    socket.write(frame(RESPONSE_CHUNK, Buffer.from("response-before-metadata"), startFrame.streamId));
    return;
  }
  if (process.env.FAKE_HELPER_REMOTE_OVERSIZED_RESPONSE_HEADERS === "1") {
    await writeResult(resultPath, result);
    socket.write(frame(RESPONSE_START, canonicalJson({
      version: 1,
      statusCode: 200,
      statusMessage: "OK",
      headers: [
        ["x-first", "a".repeat(8_192)],
        ["x-second", "b".repeat(8_192)]
      ]
    }), startFrame.streamId));
    return;
  }
  if (process.env.FAKE_HELPER_REMOTE_STREAM_UNTIL_CANCEL === "1") {
    socket.write(frame(RESPONSE_START, canonicalJson({
      version: 1,
      statusCode: 200,
      statusMessage: "OK",
      headers: [["content-type", "application/octet-stream"]]
    }), startFrame.streamId));
    socket.write(frame(RESPONSE_CHUNK, Buffer.alloc(65_536, 0x5a), startFrame.streamId));
    for (;;) {
      const incoming = await readFrame();
      if (incoming.streamId !== startFrame.streamId) throw new Error("unexpected streaming response frame");
      if (incoming.type === WINDOW_UPDATE) continue;
      if (incoming.type !== REQUEST_CANCEL) throw new Error("expected streaming response cancellation");
      result.responseCancelled = true;
      await writeResult(resultPath, result);
      socket.write(frame(RESPONSE_ERROR, canonicalJson({
        code: "cancelled",
        message: "response consumer disconnected"
      }), startFrame.streamId));
      return;
    }
  }
  await writeResult(resultPath, result);
  socket.write(frame(RESPONSE_START, canonicalJson({
    version: 1,
    statusCode: 206,
    statusMessage: "Partial Content",
    headers: [["content-type", "application/json"], ["x-helper-probe", "yes"]]
  }), startFrame.streamId));
  socket.write(frame(RESPONSE_CHUNK, Buffer.from('{"ok":'), startFrame.streamId));
  socket.write(frame(RESPONSE_CHUNK, Buffer.from("true}"), startFrame.streamId));
  socket.write(frame(RESPONSE_END, Buffer.alloc(0), startFrame.streamId));
}

async function runRemoteStreamLimitProbe(socket, readFrame, startFrame) {
  const resultPath = process.env.FAKE_HELPER_RESULT_PATH;
  if (!resultPath) throw new Error("missing stream-limit probe result path");
  const started = new Set();
  const ended = new Set();
  let incoming = startFrame;
  for (;;) {
    if (incoming.type === REQUEST_START) {
      started.add(incoming.streamId.toString(10));
      if (started.size > 128) {
        await writeResult(resultPath, {
          started: started.size,
          overflowSent: true
        });
        return;
      }
    } else if (incoming.type === REQUEST_END) {
      ended.add(incoming.streamId.toString(10));
    } else {
      throw new Error("unexpected stream-limit probe frame");
    }
    if (started.size === 128 && ended.size === 128) {
      await writeResult(resultPath, {
        started: started.size,
        overflowSent: false
      });
      return;
    }
    incoming = await readFrame();
  }
}

async function main(capability) {
  const endpointIndex = process.argv.indexOf("--parent-endpoint");
  const endpoint = process.argv[endpointIndex + 1];
  if (!endpoint) process.exit(64);
  const connectDelay = Number(process.env.FAKE_HELPER_CONNECT_DELAY_MS ?? 0);
  if (connectDelay > 0) await new Promise((resolve) => setTimeout(resolve, connectDelay));
  const socket = net.connect(endpoint);
  socket.on("close", () => process.exit(
    process.env.FAKE_HELPER_WRONG_PROOF === "1" ? 72 : 0
  ));
  const readFrame = frameReader(socket);
  const helloFrame = await readFrame();
  if (helloFrame.type !== HELLO) throw new Error("expected hello");
  const parentHello = JSON.parse(helloFrame.payload.toString("utf8"));
  const helperNonce = Buffer.alloc(32, 0x42);
  const helperHello = {
    protocol: { major: 1, minor: 0 },
    component: "ts_connect",
    componentVersion: "0.1.0",
    buildId: "ts-connect-0123456789ab",
    nonce: helperNonce.toString("base64url"),
    capabilities: { required: REQUIRED_CAPABILITIES, optional: [] },
    controlProfile: parentHello.controlProfile,
    runtimePurpose: parentHello.runtimePurpose
  };
  const helloAck = canonicalJson(helperHello);
  const authDelay = Number(process.env.FAKE_HELPER_AUTH_DELAY_MS ?? 0);
  if (authDelay > 0) await new Promise((resolve) => setTimeout(resolve, authDelay));
  socket.write(frame(HELLO_ACK, helloAck));
  const commandFrame = await readFrame();
  if (commandFrame.type !== COMMAND) throw new Error("expected command");
  const command = JSON.parse(commandFrame.payload.toString("utf8"));
  const parentProof = Buffer.from(command.parentProof, "base64url");
  const clientNonce = Buffer.from(parentHello.nonce, "base64url");
  const expectedParentProof = proof(
    Buffer.from("waifus-ipc-auth-v1"),
    capability,
    clientNonce,
    helperNonce,
    helloFrame.payload,
    helloAck
  );
  if (!timingSafeEqual(expectedParentProof, parentProof)) process.exit(71);
  let helperProof = proof(
    Buffer.from("waifus-ipc-helper-v1"),
    capability,
    clientNonce,
    helperNonce,
    helloFrame.payload,
    helloAck,
    parentProof
  );
  if (process.env.FAKE_HELPER_WRONG_PROOF === "1") {
    helperProof = Buffer.alloc(32, 0x77);
  }
  const resultFrame = frame(
    RESULT,
    canonicalJson({ helperProof: helperProof.toString("base64url") })
  );
  if (process.env.FAKE_HELPER_WRONG_PROOF === "1") {
    process.exitCode = 72;
    capabilityPipe.destroy();
    socket.end(resultFrame);
    return;
  }
  socket.write(resultFrame);
  if (process.env.FAKE_HELPER_ACTIVATION !== "1" && process.env.FAKE_HELPER_RUNTIME !== "1") return;
  for (;;) {
    const next = await readFrame();
    if (next.type === REQUEST_START && process.env.FAKE_HELPER_REMOTE_STREAM_LIMIT === "1") {
      await runRemoteStreamLimitProbe(socket, readFrame, next);
      continue;
    }
    if (next.type === REQUEST_START && process.env.FAKE_HELPER_REMOTE_REQUEST === "1") {
      await runRemoteRequestProbe(socket, readFrame, next);
      continue;
    }
    if (next.type !== COMMAND || next.streamId !== 0n) throw new Error("expected connection command");
    const activation = JSON.parse(next.payload.toString("utf8"));
    const operationId = process.env.FAKE_HELPER_ACTIVATION_MISMATCH === "1"
      ? Buffer.alloc(32, 0x56).toString("base64url")
      : activation.operationId;
    if (activation.command === "identity_status") {
      socket.write(frame(RESULT, canonicalJson({
        activationState: process.env.FAKE_HELPER_RUNTIME === "1" ? "active" : "activation_required",
        command: "identity_status",
        deviceId: "host-device-01",
        installationFingerprint: Buffer.alloc(16, 0x73).toString("base64url"),
        ok: true,
        secretStorage: "keychain"
      })));
      continue;
    }
    if (["runtime_start", "runtime_status", "runtime_reconnect", "runtime_stop"].includes(activation.command)) {
      const stopped = activation.command === "runtime_stop";
      socket.write(frame(RESULT, canonicalJson({
        activationState: "active",
        command: activation.command,
        controlState: stopped ? "inactive" : "connected",
        directState: stopped ? "inactive" : "reconnecting",
        lastDirectAt: null,
        lastErrorCode: null,
        ok: true
      })));
      if (activation.command === "runtime_start" && process.env.FAKE_HELPER_REQUEST === "1") {
        await runRequestProbe(socket, readFrame);
      }
      continue;
    }
    if (activation.command === "register_gateway_launch") {
      socket.write(frame(RESULT, canonicalJson({
        command: "register_gateway_launch",
        ok: true
      })));
      continue;
    }
    if (activation.command === "invitation_create") {
      socket.write(frame(RESULT, canonicalJson({
        command: "invitation_create",
        expiresAt: "1786271130",
        fullToken: `WF1.${Buffer.alloc(192).toString("base64url")}`,
        invitationId: Buffer.alloc(16, 0x41).toString("base64url"),
        ok: true,
        shortCode: "01AB-CDEF"
      })));
      continue;
    }
    if (activation.command === "invitation_cancel") {
      socket.write(frame(RESULT, canonicalJson({
        command: "invitation_cancel",
        invitationId: activation.invitationId,
        ok: true
      })));
      continue;
    }
    if (activation.command === "pairing_requests_list") {
      socket.write(frame(RESULT, canonicalJson({
        command: "pairing_requests_list",
        ok: true,
        requests: [],
        version: 1
      })));
      continue;
    }
    if (activation.command === "pairing_request_approve") {
      socket.write(frame(RESULT, canonicalJson({
        command: "pairing_request_approve",
        ok: true,
        requestId: activation.requestId
      })));
      continue;
    }
    if (activation.command === "pairing_request_reject") {
      socket.write(frame(RESULT, canonicalJson({
        command: "pairing_request_reject",
        ok: true,
        requestId: activation.requestId
      })));
      continue;
    }
    if (activation.command === "trusted_devices_list") {
      socket.write(frame(RESULT, canonicalJson({
        command: "trusted_devices_list",
        devices: [],
        ok: true,
        version: 1
      })));
      continue;
    }
    if (activation.command === "trusted_device_rename") {
      socket.write(frame(RESULT, canonicalJson({
        command: "trusted_device_rename",
        connectionState: "direct",
        deviceId: activation.deviceId,
        displayName: activation.input.displayName,
        installationFingerprint: Buffer.alloc(16, 0x42).toString("base64url"),
        lastSeenAt: "1786270800",
        ok: true,
        pairedAt: "1786000000",
        platform: { arch: "arm64", os: "darwin" },
        revision: String(BigInt(activation.input.revision) + 1n),
        trustEpoch: "7",
        version: 1
      })));
      continue;
    }
    if (activation.command === "trusted_device_revoke") {
      socket.write(frame(RESULT, canonicalJson({
        command: "trusted_device_revoke",
        deviceId: activation.deviceId,
        ok: true
      })));
      continue;
    }
    if (activation.command === "trusted_device_revoke_reconcile") {
      socket.write(frame(RESULT, canonicalJson({
        command: "trusted_device_revoke_reconcile",
        deviceId: activation.deviceId,
        ok: true
      })));
      continue;
    }
    if (activation.command === "activation_begin") {
      socket.write(frame(RESULT, canonicalJson({
        command: "activation_begin",
        expiresAt: "1786271400",
        ok: true,
        operationId,
        verificationUrl: `https://pair.waifucave.com/activate#${Buffer.alloc(32, 0x55).toString("base64url")}`
      })));
      continue;
    }
    if (activation.command === "activation_poll") {
      socket.write(frame(RESULT, canonicalJson({
        command: "activation_poll",
        expiresAt: "1786271400",
        ok: true,
        operationId,
        state: process.env.FAKE_HELPER_ACTIVATION_POLL_STATE ?? "pending"
      })));
      continue;
    }
    if (activation.command === "activation_cancel") {
      socket.write(frame(RESULT, canonicalJson({
        cancelled: true,
        command: "activation_cancel",
        ok: true,
        operationId
      })));
      continue;
    }
    throw new Error("unknown activation command");
  }
}

const capabilityPipe = createReadStream(null, { fd: 3, autoClose: true });
let capabilityBytes = Buffer.alloc(0);
let started = false;
capabilityPipe.on("data", (chunk) => {
  if (started) process.exit(73);
  capabilityBytes = Buffer.concat([capabilityBytes, chunk]);
  if (capabilityBytes.byteLength > 32) process.exit(73);
  if (capabilityBytes.byteLength === 32) {
    started = true;
    void main(capabilityBytes).catch(() => process.exit(74));
  }
});
capabilityPipe.on("end", () => process.exit(started ? 70 : 75));
capabilityPipe.on("error", () => process.exit(76));
