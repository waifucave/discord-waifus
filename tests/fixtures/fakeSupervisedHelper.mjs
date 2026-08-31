import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import net from "node:net";

const HEADER_BYTES = 24;
const HELLO = 0x01;
const HELLO_ACK = 0x02;
const COMMAND = 0x03;
const RESULT = 0x04;
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

function frame(type, payload) {
  const header = Buffer.alloc(HEADER_BYTES);
  header.write("WIPC", 0, "ascii");
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(0, 6);
  header.writeUInt8(type, 8);
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
    return { type: header.readUInt8(8), payload };
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
  if (process.env.FAKE_HELPER_ACTIVATION !== "1") return;
  for (;;) {
    const next = await readFrame();
    if (next.type !== COMMAND) throw new Error("expected activation command");
    const activation = JSON.parse(next.payload.toString("utf8"));
    const operationId = process.env.FAKE_HELPER_ACTIVATION_MISMATCH === "1"
      ? Buffer.alloc(32, 0x56).toString("base64url")
      : activation.operationId;
    if (activation.command === "identity_status") {
      socket.write(frame(RESULT, canonicalJson({
        activationState: "activation_required",
        command: "identity_status",
        deviceId: "host-device-01",
        installationFingerprint: Buffer.alloc(16, 0x73).toString("base64url"),
        ok: true,
        secretStorage: "keychain"
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
