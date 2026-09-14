import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AssistantActionCard,
  secureActionIsLive
} from "../src/frontend/components/assistant/AssistantPanel.js";
import {
  restoreAssistantItems,
  type ChatItem
} from "../src/frontend/state/assistantChat.js";

describe("assistant secure action presentation", () => {
  it("restores confirmation events as typed action cards without inventing model-visible detail", () => {
    const restored = restoreAssistantItems([{
      role: "event",
      cursor: `v1:${Buffer.alloc(16, 0x41).toString("base64url")}:1`,
      at: new Date(0).toISOString(),
      event: {
        type: "confirmation_required",
        actionId: Buffer.alloc(32, 0x42).toString("base64url"),
        category: "remote_device_revoke",
        summary: "Revoke Travel laptop from this host."
      }
    }]);
    expect(restored).toEqual([{
      kind: "action",
      actionId: Buffer.alloc(32, 0x42).toString("base64url"),
      category: "remote_device_revoke",
      summary: "Revoke Travel laptop from this host."
    }]);
  });

  it("retires an old action card after a newer user turn", () => {
    const action: ChatItem = {
      kind: "action",
      actionId: Buffer.alloc(32, 0x43).toString("base64url"),
      category: "remote_access_enable",
      summary: "Enable Remote Access."
    };
    expect(secureActionIsLive([action, { kind: "assistant", content: "Review the card." }], 0)).toBe(true);
    expect(secureActionIsLive([
      action,
      { kind: "user", content: "Do something else." }
    ], 0)).toBe(false);
  });

  it("renders an invitation request as a secure browser action without a token-shaped field", () => {
    const actionId = Buffer.alloc(32, 0x44).toString("base64url");
    const html = renderToStaticMarkup(createElement(AssistantActionCard, {
      item: {
        kind: "action",
        actionId,
        category: "remote_pairing_invitation",
        summary: "Create a private, short-lived invitation for another device."
      },
      onDone: () => undefined
    }));
    expect(html).toContain("Secure assistant action");
    expect(html).toContain("Create private invitation");
    expect(html).toContain(actionId);
    expect(html).not.toContain("WF1.");
    expect(html).not.toContain("href=");
  });
});
