import { expect, test, type Frame, type Page } from "@playwright/test";
import {
  createRemoteHarness,
  type RemoteHarness
} from "./fixtures/remoteHarness.js";

let harness: RemoteHarness | undefined;
const DASHBOARD_FRAME = 'iframe[title="Waifus host dashboard"]';

test.afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function openFullDashboard(page: Page): Promise<RemoteHarness> {
  await page.addInitScript(() => {
    localStorage.setItem("onboarding-dismissed", "1");
    localStorage.removeItem("onboarding-force");
  });
  const current = await createRemoteHarness({ rememberedHosts: "one", fullDashboard: true });
  harness = current;
  await current.guardBrowserEgress(page);
  await current.openShell(page);
  await expect(
    page.frameLocator(DASHBOARD_FRAME).getByText("Discord Waifus", { exact: true })
  ).toBeVisible();
  return current;
}

async function dashboardFrame(page: Page): Promise<Frame> {
  const handle = await page.locator(DASHBOARD_FRAME).elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error("The trusted dashboard frame was not available.");
  return frame;
}

async function openSettings(
  dashboard: Frame,
  tab: "Providers" | "App" | "Remote Access"
): Promise<void> {
  await dashboard.locator("button.tile").filter({ hasText: "Settings" }).click();
  await dashboard.getByRole("button", { name: tab, exact: true }).click();
}

function browserEgress(current: RemoteHarness) {
  return current.ledger.attemptedEgress.filter((entry) => entry.kind === "browser");
}

test("runs the host build and API while keeping external documentation copy-only", async ({ page }) => {
  const current = await openFullDashboard(page);
  const dashboard = await dashboardFrame(page);
  const hostId = current.hosts.a.record.hostId;

  expect(await dashboard.locator('meta[name="waifus-e2e-host"]').getAttribute("content")).toBe("a");
  const evidence = await dashboard.evaluate(async () => {
    const [runtimeResponse, contextResponse, configResponse] = await Promise.all([
      fetch("/api/runtime", { credentials: "same-origin" }),
      fetch("/api/client-context", { credentials: "same-origin", cache: "no-store" }),
      fetch("/api/config", { credentials: "same-origin" })
    ]);
    return {
      runtime: await runtimeResponse.json(),
      context: await contextResponse.json(),
      config: await configResponse.json()
    };
  });
  expect(evidence.runtime).toMatchObject({ packageVersion: "1.5.250", mode: "test" });
  expect(evidence.runtime).not.toHaveProperty("pid");
  expect(evidence.runtime).not.toHaveProperty("port");
  expect(evidence.runtime).not.toHaveProperty("dataRoot");
  expect(evidence.context).toEqual({
    mode: "remote",
    selectedHostId: hostId,
    connectionState: "direct",
    connectionShellOrigin: current.shell.origin
  });
  expect(evidence.config.http).not.toHaveProperty("host");
  expect(evidence.config.frontend).not.toHaveProperty("staticDir");

  await openSettings(dashboard, "Providers");
  const copiedLinks = dashboard.locator(".external-link-copy");
  await expect(copiedLinks.first()).toContainText("Copy this URL:");
  expect(await copiedLinks.count()).toBeGreaterThan(0);
  await expect(dashboard.locator('a[href^="http://"], a[href^="https://"]')).toHaveCount(0);
  const copiedUrls = await copiedLinks.locator("code").allTextContents();
  expect(copiedUrls.every((url) => /^https:\/\//u.test(url))).toBe(true);
  expect(browserEgress(current)).toEqual([]);
});

test("manages invitations, attended approvals, and revocation through the remote settings UI", async ({ page }) => {
  const current = await openFullDashboard(page);
  const dashboard = await dashboardFrame(page);
  await openSettings(dashboard, "Remote Access");

  await expect(dashboard.getByText("Connected directly", { exact: true })).toBeVisible();
  await expect(dashboard.getByText("Studio Host", { exact: true }).first()).toBeVisible();
  await expect(dashboard.getByText("1.5.250", { exact: true })).toBeVisible();
  await expect(dashboard.getByRole("button", { name: "Reset identity" })).toBeDisabled();
  await expect(dashboard.getByText(/Identity reset is local-only/)).toBeVisible();

  await dashboard.getByRole("button", { name: "Create invitation", exact: true }).click();
  const invitation = dashboard.locator(".invitation-card");
  await expect(invitation).toBeVisible();
  await expect(invitation.getByRole("img", { name: "QR code for this pairing invitation" })).toBeVisible();
  await expect(invitation.locator(".remote-short-code")).toHaveText("01AB-CDEF");
  const fullToken = await invitation.locator(".remote-secret-value").innerText();
  expect(fullToken).toMatch(/^WF1\.[A-Za-z0-9_-]+$/u);
  const secretSurfaces = await dashboard.evaluate(() => JSON.stringify({
    url: location.href,
    localStorage: { ...localStorage },
    sessionStorage: { ...sessionStorage }
  }));
  expect(secretSurfaces).not.toContain(fullToken);
  await invitation.getByRole("button", { name: "Cancel invitation", exact: true }).click();
  await expect(invitation).toHaveCount(0);
  expect(await dashboard.content()).not.toContain(fullToken);

  const requestCard = dashboard.locator("article.pairing-request-card").filter({
    hasText: "New Travel Laptop"
  });
  await expect(requestCard.getByLabel("Safety phrase")).toHaveText(/\S+ \S+ \S+ \S+ \S+/u);
  await expect(requestCard.getByText("a1b2c3d4e5f6", { exact: true })).toBeVisible();
  await expect(requestCard.getByRole("button", { name: "Approve device" })).toBeDisabled();
  await requestCard.getByLabel(/I compared both the words and fingerprint/).check();
  await requestCard.getByRole("button", { name: "Approve device" }).click();
  await expect(dashboard.getByText("New Travel Laptop was approved.", { exact: true })).toBeVisible();
  await expect(requestCard).toHaveCount(0);

  const device = dashboard.locator("article.trusted-device-row").filter({ hasText: "New Travel Laptop" });
  await expect(device).toBeVisible();
  await device.getByRole("button", { name: "Revoke", exact: true }).click();
  await device.getByLabel("Type New Travel Laptop to confirm revocation").fill("New Travel Laptop");
  await device.getByRole("button", { name: "Confirm revoke", exact: true }).click();
  await expect(dashboard.getByText("New Travel Laptop was revoked.", { exact: true })).toBeVisible();
  await expect(device).toHaveCount(0);

  const mutations = current.ledger.remoteManagement.filter((entry) => (
    entry.action === "invitation_create"
    || entry.action === "invitation_cancel"
    || entry.action === "pairing_request_approve"
    || entry.action === "trusted_device_revoke"
  ));
  expect(mutations.map((entry) => entry.action)).toEqual([
    "invitation_create",
    "invitation_cancel",
    "pairing_request_approve",
    "trusted_device_revoke"
  ]);
  expect(mutations.every((entry) => (
    entry.hostId === current.hosts.a.record.hostId
    && entry.actorKind === "remote_device"
  ))).toBe(true);
  expect(JSON.stringify(current.ledger)).not.toContain(fullToken);
  expect(browserEgress(current)).toEqual([]);
});
