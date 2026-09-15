import { expect, test, type Page } from "@playwright/test";
import {
  createRemoteHarness,
  type RemoteHarness
} from "./fixtures/remoteHarness.js";

const FULL_PAIR_TOKEN = "WF1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

let harness: RemoteHarness | undefined;

function dashboard(page: Page) {
  return page.frameLocator('iframe[title="Waifus host dashboard"]');
}

test.afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function browserSecretSurfaces(page: Page): Promise<string> {
  const storage = await page.evaluate(() => JSON.stringify({
    url: window.location.href,
    hash: window.location.hash,
    cookie: document.cookie,
    localStorage: { ...localStorage },
    sessionStorage: { ...sessionStorage },
    resources: performance.getEntriesByType("resource").map((entry) => entry.name),
    html: document.documentElement.outerHTML
  }));
  const cookies = JSON.stringify(await page.context().cookies());
  return `${storage}\n${cookies}`;
}

test("keeps full-token pairing attended and erases comparison details on mismatch", async ({ page }) => {
  harness = await createRemoteHarness({ rememberedHosts: "none" });
  await harness.guardBrowserEgress(page);
  await harness.openShell(page);

  await expect(page.getByRole("heading", { name: "Connect to your Waifus host." })).toBeVisible();
  await page.getByLabel("Pairing token").fill(FULL_PAIR_TOKEN);
  await page.getByRole("button", { name: "Begin pairing" }).click();

  await expect(page.getByRole("heading", { name: "Compare on both devices" })).toBeVisible();
  await expect(page.getByText("acorn · angel · jeep · slip · zoom")).toBeVisible();
  await expect(page.getByText("a1b2c3d4e5f6")).toBeVisible();
  await expect(page.getByText("Studio Host", { exact: true })).toBeVisible();
  expect(await browserSecretSurfaces(page)).not.toContain(FULL_PAIR_TOKEN);
  expect(harness.ledger.pairSubmissions).toEqual([
    { kind: "full_token", characterCount: FULL_PAIR_TOKEN.length }
  ]);

  harness.setPairOutcome("failed", "verification_mismatch");
  await expect(page.getByText("Pairing · failed")).toBeVisible();
  await expect(page.getByText("acorn · angel · jeep · slip · zoom")).toHaveCount(0);
  await expect(page.getByText("a1b2c3d4e5f6")).toHaveCount(0);
  expect(await browserSecretSurfaces(page)).not.toContain(FULL_PAIR_TOKEN);
  expect(harness.ledger.attemptedEgress.filter((entry) => entry.kind === "browser")).toEqual([]);
});

test("requires the short-code comparison before a completed pair can open its host", async ({ page }) => {
  harness = await createRemoteHarness({ rememberedHosts: "none" });
  await harness.guardBrowserEgress(page);
  await harness.openShell(page);

  await page.getByRole("button", { name: "Short code" }).click();
  await page.getByLabel("XXXX-XXXX code").fill("01ab-cdef");
  await page.getByRole("button", { name: "Begin pairing" }).click();
  await expect(page.getByRole("heading", { name: "Compare on both devices" })).toBeVisible();
  await expect(page.getByText("Pairing · verification required")).toBeVisible();
  await page.waitForTimeout(1_200);
  expect(new URL(page.url()).origin).toBe(harness.shell.origin);

  harness.setPairOutcome("completed");
  const dashboardElement = page.locator('iframe[title="Waifus host dashboard"]');
  await expect(dashboard(page).getByTestId("host-build")).toContainText("Host A · 1.5.250");
  await expect(dashboardElement).toHaveAttribute(
    "sandbox",
    "allow-scripts allow-forms allow-same-origin allow-downloads"
  );
  await expect(dashboardElement).toHaveAttribute("src", "/_waifus_remote/frame");
  await expect(dashboardElement).toHaveAttribute("referrerpolicy", "no-referrer");
  expect(page.url()).not.toContain("01AB-CDEF");
  expect(await browserSecretSurfaces(page)).not.toContain("01AB-CDEF");
  expect(harness.ledger.pairSubmissions).toEqual([
    { kind: "short_code", characterCount: 9 }
  ]);
  expect(harness.ledger.proxyRequests.every(
    (request) => request.hostId === harness!.hosts.a.record.hostId
  )).toBe(true);
});

for (const outcome of [
  { name: "rejected", state: "failed" as const, errorCode: "verification_rejected" },
  { name: "expired", state: "expired" as const, errorCode: undefined }
]) {
  test(`erases attended comparison details when pairing is ${outcome.name}`, async ({ page }) => {
    harness = await createRemoteHarness({ rememberedHosts: "none" });
    await harness.guardBrowserEgress(page);
    await harness.openShell(page);

    await page.getByLabel("Pairing token").fill(FULL_PAIR_TOKEN);
    await page.getByRole("button", { name: "Begin pairing" }).click();
    await expect(page.getByRole("heading", { name: "Compare on both devices" })).toBeVisible();
    harness.setPairOutcome(outcome.state, outcome.errorCode);

    await expect(page.getByText(`Pairing · ${outcome.state}`)).toBeVisible();
    await expect(page.getByText("acorn · angel · jeep · slip · zoom")).toHaveCount(0);
    await expect(page.getByText("a1b2c3d4e5f6")).toHaveCount(0);
    expect(new URL(page.url()).origin).toBe(harness.shell.origin);
    expect(await browserSecretSurfaces(page)).not.toContain(FULL_PAIR_TOKEN);
    expect(harness.ledger.gatewayLaunches).toEqual([]);
    expect(harness.ledger.proxyRequests).toEqual([]);
  });
}

test("automatically hands one direct remembered host to its isolated verified dashboard", async ({ page }) => {
  harness = await createRemoteHarness({ rememberedHosts: "one" });
  await harness.guardBrowserEgress(page);
  await harness.openShell(page);

  await expect(dashboard(page).getByTestId("host-build")).toContainText("Host A · 1.5.250");
  const wrapperUrl = new URL(page.url());
  const dashboardFrame = page.frames().find((frame) => frame !== page.mainFrame());
  expect(dashboardFrame).toBeDefined();
  const dashboardUrl = new URL(dashboardFrame!.url());
  expect(wrapperUrl.origin).not.toBe(harness.shell.origin);
  expect(wrapperUrl.hostname).toBe(dashboardUrl.hostname);
  expect(wrapperUrl.port).not.toBe(dashboardUrl.port);
  expect(wrapperUrl.pathname).toBe("/");
  expect(dashboardUrl.pathname).toBe("/");
  expect(page.url()).not.toContain("/_waifus_remote/bootstrap/");
  expect(dashboardFrame!.url()).not.toContain("/_waifus_remote/bootstrap/");
  const dashboardSession = (await page.context().cookies(dashboardUrl.origin)).find(
    (cookie) => cookie.httpOnly
  );
  expect(dashboardSession).toMatchObject({ sameSite: "Strict", httpOnly: true });
  expect(harness.hosts.a.buildId).not.toBe(harness.hosts.b.buildId);
  expect(harness.ledger.gatewayLaunches).toHaveLength(1);
  expect(harness.ledger.proxyRequests.length).toBeGreaterThan(0);
  expect(harness.ledger.proxyRequests.every(
    (request) => request.hostId === harness!.hosts.a.record.hostId
  )).toBe(true);
  expect(harness.ledger.attemptedEgress.filter((entry) => entry.kind === "browser")).toEqual([]);
});

test("keeps multiple hosts in the shell until the user chooses one", async ({ page }) => {
  harness = await createRemoteHarness({ rememberedHosts: "two" });
  await harness.guardBrowserEgress(page);
  await harness.openShell(page);

  await expect(page.getByRole("heading", { name: "2 hosts" })).toBeVisible();
  expect(new URL(page.url()).origin).toBe(harness.shell.origin);
  const travelHost = page.locator("article.host").filter({ hasText: "Travel Host" });
  await travelHost.getByRole("button", { name: "Connect", exact: true }).click();

  await expect(dashboard(page).getByTestId("host-build")).toContainText("Host B · 1.6.0");
  expect(harness.ledger.proxyRequests.every(
    (request) => request.hostId === harness!.hosts.b.record.hostId
  )).toBe(true);
});

test("stays usable while direct transport is unavailable and opens after reconnect", async ({ page }) => {
  harness = await createRemoteHarness({
    rememberedHosts: "two",
    initialConnection: "direct_unavailable"
  });
  await harness.guardBrowserEgress(page);
  await harness.openShell(page);

  const studioHost = page.locator("article.host").filter({ hasText: "Studio Host" });
  await studioHost.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText(/A direct connection could not be established/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh" })).toBeEnabled();
  expect(new URL(page.url()).origin).toBe(harness.shell.origin);

  await harness.setConnection(harness.hosts.a.record.hostId, "direct");
  await expect(dashboard(page).getByTestId("host-build")).toContainText("Host A · 1.5.250");
  expect(harness.ledger.proxyRequests.every(
    (request) => request.hostId === harness!.hosts.a.record.hostId
  )).toBe(true);
});
