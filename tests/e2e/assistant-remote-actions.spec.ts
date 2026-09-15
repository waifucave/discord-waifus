import { expect, test, type Frame, type Page } from "@playwright/test";
import type { ModelPipeline } from "../../src/providers/types.js";
import {
  createRemoteHarness,
  type RemoteHarness
} from "./fixtures/remoteHarness.js";

const DASHBOARD_FRAME = 'iframe[title="Waifus host dashboard"]';
const bytes32 = (value: number): string => Buffer.alloc(32, value).toString("base64url");

let harness: RemoteHarness | undefined;

test.afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function dashboardFrame(page: Page): Promise<Frame> {
  await expect(
    page.frameLocator(DASHBOARD_FRAME).getByText("Discord Waifus", { exact: true })
  ).toBeVisible();
  const handle = await page.locator(DASHBOARD_FRAME).elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error("The trusted dashboard frame was not available.");
  return frame;
}

function assistantPipeline(): ModelPipeline {
  let turn = 0;
  return {
    async generateWaifu() {
      throw new Error("unused");
    },
    async generateAssistantTurn(request) {
      turn += 1;
      const toolName = turn === 1
        ? "request_remote_pairing_invite"
        : "set_remote_access_enabled";
      const argumentsJson = turn === 1 ? "{}" : JSON.stringify({ enabled: false });
      const result = await request.executeTool(toolName, argumentsJson);
      request.onEvent?.({ type: "tool_call", name: toolName, arguments: argumentsJson });
      request.onEvent?.({ type: "tool_result", name: toolName, result });
      const content = turn === 1
        ? "Use the private invitation card."
        : "Review the pending Remote Access change.";
      return {
        content,
        messages: [...request.messages, { role: "assistant", content }]
      };
    }
  };
}

async function sendAssistantMessage(dashboard: Frame, content: string): Promise<void> {
  await dashboard.locator(".norma textarea").fill(content);
  await dashboard.locator(".norma button.send").click();
  await expect(dashboard.locator(".norma .m-busy")).toHaveCount(0);
}

test("keeps assistant ownership remote, redacts invitation secrets, and invalidates on revoke", async ({ page }) => {
  harness = await createRemoteHarness({
    rememberedHosts: "one",
    fullDashboard: true,
    assistantPipeline: assistantPipeline()
  });
  await page.addInitScript(() => {
    localStorage.setItem("onboarding-dismissed", "1");
    localStorage.removeItem("onboarding-force");
  });
  await harness.guardBrowserEgress(page);
  await harness.openShell(page);
  const dashboard = await dashboardFrame(page);

  await dashboard.getByRole("button", { name: /^Ask · change · fix Assistant/u }).click();
  await sendAssistantMessage(dashboard, "Create a remote pairing invitation");
  const invitationAction = dashboard.locator(".assistant-secure-action").last();
  await expect(
    invitationAction.getByRole("button", { name: "Create private invitation", exact: true })
  ).toBeEnabled();
  await invitationAction.getByRole("button", {
    name: "Create private invitation",
    exact: true
  }).click();

  const invitation = invitationAction.locator(".invitation-card");
  await expect(invitation).toBeVisible();
  const fullToken = await invitation.locator(".remote-secret-value").innerText();
  const shortCode = await invitation.locator(".remote-short-code").innerText();
  expect(fullToken).toMatch(/^WF1\.[A-Za-z0-9_-]+$/u);
  expect(shortCode).toBe("01AB-CDEF");

  const invitationTool = dashboard.locator(".norma .m-tool").filter({
    hasText: "request_remote_pairing_invite"
  });
  await invitationTool.getByRole("button").click();
  const chatAndToolRows = await dashboard.locator(
    ".norma .m-user, .norma .m-asst, .norma .m-tool"
  ).allInnerTexts();
  expect(chatAndToolRows.join("\n")).not.toContain(fullToken);
  expect(chatAndToolRows.join("\n")).not.toContain(shortCode);

  const conversationId = await dashboard.evaluate(() => (
    sessionStorage.getItem("assistant-conversation")
  ));
  expect(conversationId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
  );
  const conversationTarget = `/api/assistant/conversations/${conversationId}`;
  const conversationBeforeRevoke = await dashboard.evaluate(async (target) => {
    const response = await fetch(target, { credentials: "same-origin", cache: "no-store" });
    return { status: response.status, body: await response.text() };
  }, conversationTarget);
  expect(conversationBeforeRevoke.status).toBe(200);
  expect(conversationBeforeRevoke.body).not.toContain(fullToken);
  expect(conversationBeforeRevoke.body).not.toContain(shortCode);
  expect(await harness.hostLocalGet(
    harness.hosts.a.record.hostId,
    conversationTarget
  )).toMatchObject({ statusCode: 404 });
  expect(harness.ledger.remoteManagement).toContainEqual(expect.objectContaining({
    hostId: harness.hosts.a.record.hostId,
    action: "invitation_create",
    actorKind: "remote_device"
  }));

  await sendAssistantMessage(dashboard, "Disable Remote Access after I confirm it");
  const pendingAction = dashboard.locator(".assistant-secure-action").last();
  await expect(pendingAction.getByRole("button", { name: "Confirm action" })).toBeVisible();
  const actionId = await pendingAction.getAttribute("data-assistant-action");
  expect(actionId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  const actionTarget = `/api/assistant/actions/${actionId}`;
  const preRevoke = await dashboard.evaluate(async (target) => (
    await fetch(target, { credentials: "same-origin", cache: "no-store" })
  ).status, actionTarget);
  expect(preRevoke).toBe(200);
  const csrf = await dashboard.evaluate(async () => {
    const response = await fetch("/api/client-context", {
      credentials: "same-origin",
      cache: "no-store"
    });
    return response.headers.get("x-waifus-csrf");
  });
  expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/u);

  await harness.revokeRemoteAuthorization(harness.hosts.a.record.hostId);
  const invalidated = await dashboard.evaluate(async ({ conversation, action, csrfToken, key }) => {
    const [conversationResponse, actionResponse, confirmResponse] = await Promise.all([
      fetch(conversation, { credentials: "same-origin", cache: "no-store" }),
      fetch(action, { credentials: "same-origin", cache: "no-store" }),
      fetch(`${action}/confirm`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "idempotency-key": key,
          "x-waifus-csrf": csrfToken ?? ""
        },
        body: "{}"
      })
    ]);
    return {
      conversation: conversationResponse.status,
      action: actionResponse.status,
      confirm: confirmResponse.status
    };
  }, {
    conversation: conversationTarget,
    action: actionTarget,
    csrfToken: csrf,
    key: bytes32(0x79)
  });
  expect(invalidated).toEqual({ conversation: 403, action: 403, confirm: 403 });
  expect(JSON.stringify(harness.ledger)).not.toContain(fullToken);
  expect(JSON.stringify(harness.ledger)).not.toContain(shortCode);
  expect(harness.ledger.attemptedEgress.filter((entry) => entry.kind === "browser")).toEqual([]);
});
