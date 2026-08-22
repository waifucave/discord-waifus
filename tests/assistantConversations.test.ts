import { describe, expect, it } from "vitest";
import { ConversationStore } from "../src/api/assistant/conversations.js";

describe("ConversationStore", () => {
  it("creates, records messages, and fans out events to subscribers", async () => {
    const store = new ConversationStore();
    const { id } = store.create();
    const seen: string[] = [];
    const unsubscribe = store.subscribe(id, (event) => seen.push(event.type));

    store.emit(id, { type: "turn_started" });
    store.emit(id, { type: "tool_call", name: "list_waifus", arguments: "{}" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    unsubscribe();
    store.emit(id, { type: "turn_completed" });
    store.emit(id, {
      type: "confirmation_required",
      actionId: "action-1",
      category: "external_side_effect",
      summary: "Send a message"
    });

    expect(seen).toEqual(["turn_started", "tool_call"]);
    const convo = store.get(id)!;
    const events = convo.messages.filter((message) => message.role === "event");
    expect(events).toHaveLength(4);
    expect(events.at(-1)).toMatchObject({
      event: { type: "confirmation_required", actionId: "action-1" },
      cursor: expect.stringMatching(/^v1:[A-Za-z0-9_-]{21}[AQgw]:4$/u)
    });
  });

  it("stores user/assistant display messages and the model transcript separately", () => {
    const store = new ConversationStore();
    const { id } = store.create();
    store.appendStored(id, { role: "user", content: "hi", at: new Date().toISOString() });
    store.appendChat(id, [{ role: "system", content: "sys" }, { role: "user", content: "hi" }]);
    const convo = store.get(id)!;
    expect(convo.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(convo.chat).toHaveLength(2);
  });

  it("guards concurrent turns with the busy flag", () => {
    const store = new ConversationStore();
    const { id } = store.create();
    expect(store.get(id)!.busy).toBe(false);
    store.setBusy(id, true);
    expect(store.get(id)!.busy).toBe(true);
  });

  it("evicts the oldest conversation past the cap of 20", () => {
    const store = new ConversationStore();
    const first = store.create().id;
    for (let i = 0; i < 20; i++) store.create();
    expect(store.get(first)).toBeUndefined();
    expect(store.create().id).toBeTruthy();
  });
});
