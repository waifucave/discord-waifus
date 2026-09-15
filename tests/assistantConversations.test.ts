import { describe, expect, it } from "vitest";
import {
  ConversationStore,
  conversationOwner
} from "../src/api/assistant/conversations.js";
import {
  LOCAL_REQUEST_PRINCIPAL,
  createLocalRequestPrincipal,
  createRemoteRequestPrincipal
} from "../src/api/requestPrincipal.js";

const localOwner = conversationOwner(LOCAL_REQUEST_PRINCIPAL);

function localBrowserOwner(byte: number) {
  const token = Buffer.alloc(32, byte).toString("base64url");
  return conversationOwner(createLocalRequestPrincipal({
    verifiedBy: "host_server",
    hostServerLaunchId: Buffer.alloc(32, 0x31).toString("base64url"),
    browserSessionId: token,
    requestNonce: Buffer.alloc(16, byte).toString("base64url"),
    method: "GET",
    canonicalTarget: "/api/assistant/conversations",
    csrfValidated: false
  }));
}

function remoteOwner(deviceId: string, trustEpoch = "1") {
  return conversationOwner(createRemoteRequestPrincipal({
    kind: "remote_device",
    stableId: `remote:${deviceId}`,
    deviceId,
    peerFingerprint: Buffer.alloc(16, 0x41).toString("base64url"),
    transportSessionId: Buffer.alloc(16, 0x42).toString("base64url"),
    trustEpoch
  }));
}

describe("ConversationStore", () => {
  it("creates, records messages, and fans out events to subscribers", async () => {
    const store = new ConversationStore();
    const { id } = store.create(localOwner);
    const seen: string[] = [];
    const unsubscribe = store.subscribe(id, localOwner, (event) => seen.push(event.type));

    store.emit(id, localOwner, { type: "turn_started" });
    store.emit(id, localOwner, { type: "tool_call", name: "list_waifus", arguments: "{}" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    unsubscribe();
    store.emit(id, localOwner, { type: "turn_completed" });
    store.emit(id, localOwner, {
      type: "confirmation_required",
      actionId: "action-1",
      category: "external_side_effect",
      summary: "Send a message"
    });

    expect(seen).toEqual(["turn_started", "tool_call"]);
    const convo = store.get(id, localOwner)!;
    const events = convo.messages.filter((message) => message.role === "event");
    expect(events).toHaveLength(4);
    expect(events.at(-1)).toMatchObject({
      event: { type: "confirmation_required", actionId: "action-1" },
      cursor: expect.stringMatching(/^v1:[A-Za-z0-9_-]{21}[AQgw]:4$/u)
    });
  });

  it("stores user/assistant display messages and the model transcript separately", () => {
    const store = new ConversationStore();
    const { id } = store.create(localOwner);
    store.appendStored(id, localOwner, { role: "user", content: "hi", at: new Date().toISOString() });
    store.appendChat(id, localOwner, [{ role: "system", content: "sys" }, { role: "user", content: "hi" }]);
    const convo = store.get(id, localOwner)!;
    expect(convo.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(convo.chat).toHaveLength(2);
  });

  it("guards concurrent turns with the busy flag", () => {
    const store = new ConversationStore();
    const { id } = store.create(localOwner);
    expect(store.get(id, localOwner)!.busy).toBe(false);
    store.setBusy(id, localOwner, true);
    expect(store.get(id, localOwner)!.busy).toBe(true);
  });

  it("evicts the oldest conversation past the cap of 20", () => {
    const store = new ConversationStore();
    const first = store.create(localOwner).id;
    for (let i = 0; i < 20; i++) store.create(localOwner);
    expect(store.get(first, localOwner)).toBeUndefined();
    expect(store.create(localOwner).id).toBeTruthy();
  });

  it("binds conversations to actor kind, stable identity, and trust epoch", () => {
    const store = new ConversationStore();
    const owner = remoteOwner("travel-mac", "5");
    const id = store.create(owner).id;

    expect(store.get(id, owner)).toBeDefined();
    expect(store.get(id, remoteOwner("studio-pc", "5"))).toBeUndefined();
    expect(store.get(id, remoteOwner("travel-mac", "6"))).toBeUndefined();
    expect(store.get(id, localOwner)).toBeUndefined();
    expect(store.list(localOwner)).toEqual([]);
    expect(store.delete(id, localOwner)).toBe(false);
  });

  it("isolates local browser sessions even though their stable actor is local", () => {
    const store = new ConversationStore();
    const browserA = localBrowserOwner(0x51);
    const browserB = localBrowserOwner(0x52);
    const id = store.create(browserA).id;

    expect(store.get(id, browserA)).toBeDefined();
    expect(store.get(id, browserB)).toBeUndefined();
    expect(store.eventStream(id, browserB)).toBeUndefined();
  });

  it("invalidates every conversation for one revoked device epoch only", () => {
    const store = new ConversationStore();
    const revokedOwner = remoteOwner("travel-mac", "5");
    const revokedIds = [store.create(revokedOwner).id, store.create(revokedOwner).id];
    const repairedEpochOwner = remoteOwner("travel-mac", "6");
    const repairedEpochId = store.create(repairedEpochOwner).id;
    const otherOwner = remoteOwner("studio-pc", "5");
    const otherId = store.create(otherOwner).id;
    const localId = store.create(localOwner).id;

    expect(store.invalidateOwner("remote:travel-mac", "5")).toBe(2);

    for (const id of revokedIds) expect(store.get(id, revokedOwner)).toBeUndefined();
    expect(store.get(repairedEpochId, repairedEpochOwner)).toBeDefined();
    expect(store.get(otherId, otherOwner)).toBeDefined();
    expect(store.get(localId, localOwner)).toBeDefined();
  });
});
