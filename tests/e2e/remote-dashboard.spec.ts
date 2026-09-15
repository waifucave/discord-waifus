import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Frame, type Page } from "@playwright/test";
import {
  createRemoteHarness,
  type RemoteHarness
} from "./fixtures/remoteHarness.js";

const bytes32 = (value: number): string => Buffer.alloc(32, value).toString("base64url");

let harness: RemoteHarness | undefined;
const DASHBOARD_FRAME = 'iframe[title="Waifus host dashboard"]';

test.afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function dashboardLocator(page: Page) {
  return page.frameLocator(DASHBOARD_FRAME);
}

async function dashboardFrame(page: Page): Promise<Frame> {
  const handle = await page.locator(DASHBOARD_FRAME).elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error("The trusted dashboard frame was not available.");
  return frame;
}

async function selectHost(
  page: Page,
  current: RemoteHarness,
  key: "a" | "b"
): Promise<void> {
  await current.openShell(page);
  const host = current.hosts[key];
  const card = page.locator("article.host").filter({ hasText: host.record.displayName });
  await card.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(dashboardLocator(page).getByTestId("host-build")).toContainText(
    `Host ${key.toUpperCase()}`
  );
}

function browserEgress(current: RemoteHarness) {
  return current.ledger.attemptedEgress.filter((entry) => entry.kind === "browser");
}

async function openFullDashboard(page: Page): Promise<RemoteHarness> {
  await page.addInitScript(() => {
    localStorage.setItem("onboarding-dismissed", "1");
    localStorage.removeItem("onboarding-force");
  });
  const current = await createRemoteHarness({ rememberedHosts: "one", fullDashboard: true });
  harness = current;
  await current.guardBrowserEgress(page);
  await current.openShell(page);
  await expect(dashboardLocator(page).getByText("Discord Waifus", { exact: true })).toBeVisible();
  return current;
}

test("isolates host origins, storage, cookies, policy, and network authority", async ({ page, context }) => {
  harness = await createRemoteHarness({ rememberedHosts: "two" });
  await harness.guardBrowserEgress(page);
  await selectHost(page, harness, "a");

  let dashboard = await dashboardFrame(page);
  const wrapperOriginA = new URL(page.url()).origin;
  const originA = new URL(dashboard.url()).origin;
  expect(new URL(wrapperOriginA).hostname).toBe(new URL(originA).hostname);
  expect(wrapperOriginA).not.toBe(originA);
  const documentResponse = await dashboard.goto(dashboard.url(), { waitUntil: "domcontentloaded" });
  expect(documentResponse).not.toBeNull();
  const csp = documentResponse!.headers()["content-security-policy"];
  expect(csp.split(";").map((value) => value.trim())[0]).toBe(
    "sandbox allow-scripts allow-forms allow-same-origin allow-downloads"
  );
  expect(csp).not.toContain("allow-popups");
  expect(csp).not.toContain("allow-top-navigation");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).toContain("worker-src 'none'");

  const initialCookies = await context.cookies(originA);
  const sessionCookies = initialCookies.filter((cookie) => cookie.httpOnly);
  expect(sessionCookies).toHaveLength(2);
  expect(sessionCookies.every((cookie) => cookie.sameSite === "Strict")).toBe(true);
  const scriptCookieState = await dashboard.evaluate(async (sessionNames) => {
    localStorage.setItem("host-marker", "a");
    sessionStorage.setItem("host-session-marker", "a");
    const cache = await caches.open("host-a-cache");
    await cache.put("/host-a-marker", new Response("a"));
    document.cookie = "ordinary_a=visible; Path=/; SameSite=Strict";
    document.cookie = "parent_attempt=forbidden; Domain=localhost; Path=/";
    for (const sessionName of sessionNames) {
      document.cookie = `${sessionName}=attacker; Path=/`;
    }
    return document.cookie;
  }, sessionCookies.map((cookie) => cookie.name));
  expect(scriptCookieState).toContain("ordinary_a=visible");
  expect(scriptCookieState).not.toContain("parent_attempt");
  expect(sessionCookies.every((cookie) => !scriptCookieState.includes(cookie.name))).toBe(true);
  const cookiesAfterScript = await context.cookies(originA);
  for (const sessionCookie of sessionCookies) {
    expect(cookiesAfterScript.find((cookie) => cookie.name === sessionCookie.name)?.value).toBe(
      sessionCookie.value
    );
  }
  expect(cookiesAfterScript.some((cookie) => cookie.name === "parent_attempt")).toBe(false);

  const policyResponse = await dashboard.evaluate(async () => {
    const response = await fetch("/api/e2e/policy", { credentials: "same-origin" });
    return {
      status: response.status,
      csp: response.headers.get("content-security-policy"),
      serviceWorker: response.headers.get("service-worker-allowed"),
      cors: response.headers.get("access-control-allow-origin")
    };
  });
  expect(policyResponse.status).toBe(200);
  expect(policyResponse.csp).toBe(csp);
  expect(policyResponse.serviceWorker).toBeNull();
  expect(policyResponse.cors).toBeNull();
  expect((await context.cookies(originA)).some((cookie) => cookie.name === "host_session")).toBe(false);
  const policyRequest = harness.ledger.proxyRequests.find(
    (request) => request.canonicalTarget === "/api/e2e/policy"
  );
  expect(policyRequest).toBeDefined();
  expect(policyRequest!.headers.map(([name]) => name)).not.toContain("cookie");

  const serviceWorkerResult = await dashboard.evaluate(async () => {
    try {
      await navigator.serviceWorker.register("/sw.js");
      return "registered";
    } catch (error) {
      return error instanceof Error ? error.name : "rejected";
    }
  });
  expect(serviceWorkerResult).not.toBe("registered");

  const externalRequests: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith(originA)) externalRequests.push(request.url());
  });
  const externalFetch = await dashboard.evaluate(async () => {
    try {
      await fetch("https://example.invalid/blocked");
      return "resolved";
    } catch (error) {
      return error instanceof Error ? error.name : "rejected";
    }
  });
  expect(externalFetch).not.toBe("resolved");
  expect(await dashboard.evaluate(() => window.open("https://example.invalid/popup", "_blank") === null))
    .toBe(true);
  await dashboard.evaluate(() => {
    const link = document.createElement("a");
    link.href = "https://example.invalid/navigation";
    link.target = "_top";
    link.textContent = "malicious navigation";
    document.body.append(link);
    link.click();
  });
  await page.waitForTimeout(100);
  expect(new URL(page.url()).origin).toBe(wrapperOriginA);
  expect(new URL(dashboard.url()).origin).toBe(originA);
  expect(externalRequests).toEqual([]);
  expect(browserEgress(harness)).toEqual([]);

  await selectHost(page, harness, "b");
  dashboard = await dashboardFrame(page);
  const originB = new URL(dashboard.url()).origin;
  expect(originB).not.toBe(originA);
  expect(await dashboard.evaluate(async () => ({
    local: localStorage.getItem("host-marker"),
    session: sessionStorage.getItem("host-session-marker"),
    cookie: document.cookie,
    caches: await caches.keys()
  }))).toEqual({ local: null, session: null, cookie: "", caches: [] });
  expect((await context.cookies(originB)).some((cookie) => cookie.name === "ordinary_a")).toBe(false);
  const dashboardLocalApi = await dashboard.evaluate(async () => (
    await fetch("/_waifus_remote/v1/bootstrap", { credentials: "same-origin" })
  ).status);
  expect(dashboardLocalApi).toBe(404);

  let crossHostRequest = false;
  page.on("request", (request) => {
    if (request.url().startsWith(originA)) crossHostRequest = true;
  });
  const crossHostFetch = await dashboard.evaluate(async (url) => {
    try {
      await fetch(`${url}/api/status`);
      return "resolved";
    } catch (error) {
      return error instanceof Error ? error.name : "rejected";
    }
  }, originA);
  expect(crossHostFetch).not.toBe("resolved");
  await page.waitForTimeout(100);
  expect(crossHostRequest).toBe(false);
  expect(browserEgress(harness)).toEqual([]);
});

test("forget and re-pair advances the origin and leaves old browser state behind", async ({ page, context }) => {
  harness = await createRemoteHarness({ rememberedHosts: "two" });
  await harness.guardBrowserEgress(page);
  await selectHost(page, harness, "a");
  let dashboard = await dashboardFrame(page);
  const oldOrigin = new URL(dashboard.url()).origin;
  const oldBinding = harness.ledger.dashboardBindings.at(-1)!;
  await dashboard.evaluate(() => {
    localStorage.setItem("retired-origin", "must-not-migrate");
    document.cookie = "retired_cookie=must-not-migrate; Path=/";
  });

  await harness.forgetAndRepair(harness.hosts.a.record.hostId);
  await selectHost(page, harness, "a");
  dashboard = await dashboardFrame(page);
  const newOrigin = new URL(dashboard.url()).origin;
  const newBinding = harness.ledger.dashboardBindings.at(-1)!;
  expect(newOrigin).not.toBe(oldOrigin);
  expect(BigInt(newBinding.localOriginEpoch)).toBeGreaterThan(BigInt(oldBinding.localOriginEpoch));
  expect(await dashboard.evaluate(() => ({
    local: localStorage.getItem("retired-origin"),
    cookie: document.cookie
  }))).toEqual({ local: null, cookie: "" });
  expect((await context.cookies(newOrigin)).some((cookie) => cookie.name === "retired_cookie"))
    .toBe(false);
  const oldOriginResponse = await context.request.get(`${oldOrigin}/`, { timeout: 5_000 });
  expect(oldOriginResponse.status()).toBe(403);
});

test("a preferred-port collision rotates both the epoch and hostname before serving", async ({ page }) => {
  harness = await createRemoteHarness({ rememberedHosts: "one" });
  await harness.guardBrowserEgress(page);
  await harness.openShell(page);
  await expect(dashboardLocator(page).getByTestId("host-build")).toContainText("Host A");
  let dashboard = await dashboardFrame(page);
  const oldOrigin = new URL(dashboard.url()).origin;
  const oldBinding = harness.ledger.dashboardBindings.at(-1)!;
  await dashboard.evaluate(() => {
    localStorage.setItem("failed-port-origin", "must-not-migrate");
    document.cookie = "failed_port_cookie=must-not-migrate; Path=/";
  });

  const blockedPort = await harness.forcePreferredPortCollision();
  expect(blockedPort).toBe(oldBinding.port);
  await harness.openShell(page);
  await expect(dashboardLocator(page).getByTestId("host-build")).toContainText("Host A");
  dashboard = await dashboardFrame(page);
  const newBinding = harness.ledger.dashboardBindings.at(-1)!;
  expect(new URL(dashboard.url()).origin).not.toBe(oldOrigin);
  expect(newBinding.port).not.toBe(oldBinding.port);
  expect(newBinding.hostname).not.toBe(oldBinding.hostname);
  expect(BigInt(newBinding.localOriginEpoch)).toBeGreaterThan(BigInt(oldBinding.localOriginEpoch));
  expect(await dashboard.evaluate(() => ({
    local: localStorage.getItem("failed-port-origin"),
    cookie: document.cookie
  }))).toEqual({ local: null, cookie: "" });
});

test("proxies representative CRUD and binary transfers to the selected host", async ({ page }) => {
  const current = await openFullDashboard(page);
  const dashboard = await dashboardFrame(page);
  const idempotencyKeys = {
    config: bytes32(0x31),
    create: bytes32(0x32),
    update: bytes32(0x33),
    upload: bytes32(0x34),
    remove: bytes32(0x35)
  };
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

  const result = await dashboard.evaluate(async ({ keys, pngBytes }) => {
    const context = await fetch("/api/client-context", {
      credentials: "same-origin",
      cache: "no-store"
    });
    const csrf = context.headers.get("x-waifus-csrf");
    if (!csrf) throw new Error("Missing remote browser CSRF token.");
    const jsonMutation = async (
      method: string,
      target: string,
      key: string,
      body: unknown
    ) => {
      const response = await fetch(target, {
        method,
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "idempotency-key": key,
          "x-waifus-csrf": csrf
        },
        body: JSON.stringify(body)
      });
      const text = await response.text();
      return {
        status: response.status,
        body: text ? JSON.parse(text) : null
      };
    };

    const initialConfig = await (await fetch("/api/config", {
      credentials: "same-origin"
    })).json();
    const config = await jsonMutation("PUT", "/api/config", keys.config, {
      ocr: { enabled: !initialConfig.ocr.enabled }
    });
    const created = await jsonMutation("POST", "/api/waifus", keys.create, {
      id: "browser-parity",
      name: "Browser Parity",
      displayName: "Browser Parity"
    });
    const listedAfterCreate = await (await fetch("/api/waifus", {
      credentials: "same-origin"
    })).json();
    const updated = await jsonMutation(
      "PUT",
      "/api/waifus/browser-parity",
      keys.update,
      { revision: created.body.revision, persona: "Runs on the selected host." }
    );
    const uploadBytes = Uint8Array.from(atob(pngBytes), (value) => value.charCodeAt(0));
    const uploadResponse = await fetch("/api/waifus/browser-parity/assets/pfp", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "image/png",
        "idempotency-key": keys.upload,
        "x-waifus-csrf": csrf
      },
      body: uploadBytes
    });
    const upload = { status: uploadResponse.status, body: await uploadResponse.json() };
    const downloadResponse = await fetch("/api/e2e/download", { credentials: "same-origin" });
    const download = new Uint8Array(await downloadResponse.arrayBuffer());
    const removed = await jsonMutation(
      "DELETE",
      "/api/waifus/browser-parity",
      keys.remove,
      { revision: updated.body.revision }
    );
    const listedAfterDelete = await (await fetch("/api/waifus", {
      credentials: "same-origin"
    })).json();
    return {
      config,
      created,
      listedAfterCreate,
      updated,
      upload,
      download: {
        status: downloadResponse.status,
        disposition: downloadResponse.headers.get("content-disposition"),
        bytes: download.byteLength,
        first: download[0],
        last: download[download.length - 1]
      },
      removed,
      listedAfterDelete
    };
  }, { keys: idempotencyKeys, pngBytes: png });

  expect(result.config).toMatchObject({ status: 200, body: { ocr: { enabled: false } } });
  expect(result.created).toMatchObject({
    status: 201,
    body: { id: "browser-parity", displayName: "Browser Parity", revision: 0 }
  });
  expect(result.listedAfterCreate.waifus).toContainEqual(
    expect.objectContaining({ id: "browser-parity" })
  );
  expect(result.updated).toMatchObject({
    status: 200,
    body: { id: "browser-parity", revision: 1, persona: "Runs on the selected host." }
  });
  expect(result.upload).toMatchObject({
    status: 201,
    body: { ok: true, kind: "pfp", waifuId: "browser-parity", contentType: "image/png" }
  });
  expect(result.download).toEqual({
    status: 200,
    disposition: 'attachment; filename="remote-e2e.bin"',
    bytes: 256 * 1_024,
    first: 0,
    last: 15
  });
  expect(result.removed.status).toBe(204);
  expect(result.listedAfterDelete.waifus).not.toContainEqual(
    expect.objectContaining({ id: "browser-parity" })
  );

  const mutatingTargets = new Set([
    "/api/config",
    "/api/waifus",
    "/api/waifus/browser-parity",
    "/api/waifus/browser-parity/assets/pfp"
  ]);
  const mutations = current.ledger.proxyRequests.filter((entry) => (
    entry.method !== "GET" && mutatingTargets.has(entry.canonicalTarget)
  ));
  expect(mutations).toHaveLength(5);
  expect(mutations.map((entry) => (
    entry.headers.find(([name]) => name === "idempotency-key")?.[1]
  ))).toEqual(Object.values(idempotencyKeys));
  expect(mutations.every((entry) => (
    entry.hostId === current.hosts.a.record.hostId
    && entry.browserContext.csrfValidated
    && !entry.headers.some(([name]) => name === "cookie" || name === "x-waifus-csrf")
  ))).toBe(true);
  expect(browserEgress(current)).toEqual([]);
});

test("resumes and resets SSE streams and propagates browser cancellation", async ({ page }) => {
  const current = await openFullDashboard(page);
  const dashboard = await dashboardFrame(page);
  const foreignCursor = `v1:${Buffer.alloc(16, 0x7d).toString("base64url")}:1`;
  const configKey = bytes32(0x41);

  const result = await dashboard.evaluate(async ({ foreign, key }) => {
    type Frame = { event: string; id: string | null; data: unknown };
    const parseFrame = (block: string): Frame => {
      const lines = block.split(/\r?\n/u);
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "message";
      const id = lines.find((line) => line.startsWith("id: "))?.slice(4) ?? null;
      const data = lines
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n");
      return { event, id, data: data ? JSON.parse(data) : null };
    };
    const readFrames = async (lastEventId: string | undefined, count: number): Promise<Frame[]> => {
      const controller = new AbortController();
      const response = await fetch("/api/events", {
        credentials: "same-origin",
        cache: "no-store",
        headers: lastEventId ? { "Last-Event-ID": lastEventId } : {},
        signal: controller.signal
      });
      if (!response.ok || !response.body) throw new Error(`SSE returned ${response.status}.`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      const frames: Frame[] = [];
      while (frames.length < count) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("SSE ended before the expected frame.");
        pending += decoder.decode(chunk.value, { stream: true });
        while (frames.length < count) {
          const boundary = pending.indexOf("\n\n");
          if (boundary < 0) break;
          frames.push(parseFrame(pending.slice(0, boundary)));
          pending = pending.slice(boundary + 2);
        }
      }
      await reader.cancel();
      controller.abort();
      return frames;
    };

    const first = (await readFrames(undefined, 1))[0]!;
    const context = await fetch("/api/client-context", {
      credentials: "same-origin",
      cache: "no-store"
    });
    const csrf = context.headers.get("x-waifus-csrf");
    if (!csrf) throw new Error("Missing remote browser CSRF token.");
    const configResponse = await fetch("/api/config", {
      method: "PUT",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "idempotency-key": key,
        "x-waifus-csrf": csrf
      },
      body: JSON.stringify({ runtime: { paused: true } })
    });
    const replay = (await readFrames(first.id ?? undefined, 1))[0]!;
    const reset = await readFrames(foreign, 2);

    const slowController = new AbortController();
    const slowResponse = await fetch("/api/e2e/slow", {
      credentials: "same-origin",
      signal: slowController.signal
    });
    if (!slowResponse.body) throw new Error("Slow response had no body.");
    const slowReader = slowResponse.body.getReader();
    const firstChunk = await slowReader.read();
    slowController.abort();
    await slowReader.cancel().catch(() => undefined);
    return {
      first,
      configStatus: configResponse.status,
      replay,
      reset,
      slowPrefix: new TextDecoder().decode(firstChunk.value)
    };
  }, { foreign: foreignCursor, key: configKey });

  expect(result.first).toMatchObject({
    event: "snapshot",
    id: expect.stringMatching(/^v1:[A-Za-z0-9_-]+:0$/u),
    data: { version: 1, runtime: { packageVersion: "1.5.250", paused: false } }
  });
  expect(result.configStatus).toBe(200);
  expect(result.replay).toMatchObject({
    event: "runtime",
    data: { packageVersion: "1.5.250", paused: true }
  });
  expect(result.replay.id).not.toBe(result.first.id);
  expect(result.reset[0]).toMatchObject({
    event: "snapshot_required",
    id: null,
    data: { version: 1, type: "snapshot_required", reason: "epoch_mismatch" }
  });
  expect(result.reset[1]).toMatchObject({ event: "snapshot" });
  expect(result.slowPrefix).toBe("stream-started");
  await expect.poll(() => current.ledger.cancellations.filter(
    (entry) => entry.canonicalTarget === "/api/events"
      || entry.canonicalTarget === "/api/e2e/slow"
  ).length).toBeGreaterThanOrEqual(4);
  expect(current.ledger.eventCursors).toEqual(expect.arrayContaining([
    result.first.id!,
    foreignCursor
  ]));
  expect(current.ledger.proxyRequests.filter(
    (entry) => entry.canonicalTarget === "/api/config"
  ).at(-1)?.headers).toContainEqual(["idempotency-key", configKey]);
  expect(browserEgress(current)).toEqual([]);
});

test("recovers applied mutations with one logical key and rotates the key for a new action", async ({ page }) => {
  const current = await openFullDashboard(page);
  const dashboard = await dashboardFrame(page);
  let droppedCreate = false;
  await page.route("**/api/waifus", async (route) => {
    if (route.request().method() !== "POST" || droppedCreate) {
      await route.continue();
      return;
    }
    droppedCreate = true;
    const applied = await route.fetch();
    expect(applied.status()).toBe(201);
    await route.abort("connectionclosed");
  });

  await dashboard.locator("button.tile").filter({ hasText: "Cast" }).click();
  await dashboard.getByRole("button", { name: "+ New character", exact: true }).click();
  const identityFields = dashboard.locator(".fgrid").filter({
    has: dashboard.locator('input[placeholder="momo"]')
  }).locator(".fcell");
  await identityFields.nth(0).locator("input").fill("browser-retry");
  await identityFields.nth(1).locator("input").fill("Browser Retry");
  await identityFields.nth(2).locator("input").fill("Browser Retry");
  await dashboard.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => dashboard.url()).toMatch(/#\/cast\?id=browser-retry$/u);
  const created = await dashboard.evaluate(async () => (
    await (await fetch("/api/waifus", { credentials: "same-origin" })).json()
  ));
  expect(created.waifus.filter((waifu: { id: string }) => waifu.id === "browser-retry"))
    .toHaveLength(1);
  const creates = current.ledger.proxyRequests.filter((entry) => (
    entry.method === "POST" && entry.canonicalTarget === "/api/waifus"
  ));
  expect(creates).toHaveLength(2);
  const createKeys = creates.map((entry) => (
    entry.headers.find(([name]) => name === "idempotency-key")?.[1]
  ));
  expect(createKeys[0]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(createKeys[1]).toBe(createKeys[0]);
  await page.unroute("**/api/waifus");

  await dashboard.evaluate(() => {
    location.hash = "/settings?tab=remote-access";
  });
  await expect(dashboard.getByRole("button", { name: "Reconnect", exact: true })).toBeEnabled();
  let droppedReconnect = false;
  await page.route("**/api/remote-access/reconnect", async (route) => {
    if (droppedReconnect) {
      await route.continue();
      return;
    }
    droppedReconnect = true;
    const applied = await route.fetch();
    expect(applied.status()).toBe(202);
    await route.abort("connectionclosed");
  });

  await dashboard.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(dashboard.getByText("Direct reconnection started.", { exact: true })).toBeVisible();
  await expect.poll(() => current.ledger.proxyRequests.filter((entry) => (
    entry.method === "POST" && entry.canonicalTarget === "/api/remote-access/reconnect"
  )).length).toBe(2);
  await dashboard.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect.poll(() => current.ledger.proxyRequests.filter((entry) => (
    entry.method === "POST" && entry.canonicalTarget === "/api/remote-access/reconnect"
  )).length).toBe(3);

  const reconnects = current.ledger.proxyRequests.filter((entry) => (
    entry.method === "POST" && entry.canonicalTarget === "/api/remote-access/reconnect"
  ));
  const reconnectKeys = reconnects.map((entry) => (
    entry.headers.find(([name]) => name === "idempotency-key")?.[1]
  ));
  expect(reconnectKeys[0]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(reconnectKeys[1]).toBe(reconnectKeys[0]);
  expect(reconnectKeys[2]).not.toBe(reconnectKeys[0]);
  await expect.poll(() => current.ledger.remoteManagement.filter(
    (entry) => entry.action === "reconnect"
  ).length).toBe(2);
  expect(browserEgress(current)).toEqual([]);
});

test("does not retry a non-replayable assistant turn after its outcome becomes unknown", async ({ page }) => {
  const current = await openFullDashboard(page);
  const dashboard = await dashboardFrame(page);
  let dropped = false;
  await page.route("**/api/assistant/conversations/*/messages", async (route) => {
    dropped = true;
    await route.fetch();
    await route.abort("connectionclosed");
  });

  await dashboard.getByRole("button", { name: /^Ask · change · fix Assistant/u }).click();
  await dashboard.locator(".norma textarea").fill("Run one non-replayable browser check");
  await dashboard.locator(".norma button.send").click();
  await expect(dashboard.locator(".norma .m-err")).toContainText(
    "The connection changed before this action's outcome was known."
  );
  expect(dropped).toBe(true);
  const sends = current.ledger.proxyRequests.filter((entry) => (
    entry.method === "POST"
    && /^\/api\/assistant\/conversations\/[^/]+\/messages$/u.test(entry.canonicalTarget)
  ));
  expect(sends).toHaveLength(1);
  expect(sends[0]!.headers.find(([name]) => name === "idempotency-key")?.[1])
    .toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(browserEgress(current)).toEqual([]);
});

test("downloads and executes a newer build from the host after the host updates", async ({ page }) => {
  const current = await openFullDashboard(page);
  let dashboard = await dashboardFrame(page);
  const oldOrigin = new URL(dashboard.url()).origin;
  const oldBuildId = current.hosts.a.buildId;
  await expect(dashboard.locator('meta[name="waifus-e2e-version"]')).toHaveAttribute(
    "content",
    "1.5.250"
  );
  await dashboard.evaluate(() => localStorage.setItem("build-update-marker", "preserved"));

  const updated = await current.updateHostBuild(current.hosts.a.record.hostId, "1.5.251");
  expect(updated.buildId).not.toBe(oldBuildId);
  const remoteInstallManifest = JSON.parse(await readFile(
    path.join(process.cwd(), "dist-frontend", "waifus-dashboard-manifest.json"),
    "utf8"
  )) as { buildId: string };
  expect(updated.buildId).not.toBe(remoteInstallManifest.buildId);

  await current.openShell(page);
  await expect(dashboardLocator(page).getByText("Discord Waifus", { exact: true })).toBeVisible();
  dashboard = await dashboardFrame(page);
  expect(new URL(dashboard.url()).origin).toBe(oldOrigin);
  await expect(dashboard.locator('meta[name="waifus-e2e-host"]')).toHaveAttribute("content", "a");
  await expect(dashboard.locator('meta[name="waifus-e2e-version"]')).toHaveAttribute(
    "content",
    "1.5.251"
  );
  expect(await dashboard.evaluate(() => localStorage.getItem("build-update-marker"))).toBe("preserved");
  const executingManifest = await dashboard.evaluate(async () => (
    await (await fetch("/api/remote-access/dashboard-manifest", {
      credentials: "same-origin",
      cache: "no-store"
    })).json()
  ));
  expect(executingManifest.buildId).toBe(updated.buildId);
  const manifestRequests = current.ledger.proxyRequests.filter((entry) => (
    entry.canonicalTarget === "/api/remote-access/dashboard-manifest"
  ));
  expect(manifestRequests.length).toBeGreaterThanOrEqual(3);
  expect(current.ledger.proxyRequests.some((entry) => (
    entry.canonicalTarget.startsWith(
      `/api/remote-access/dashboard-assets/${updated.buildId}/`
    )
  ))).toBe(true);
  expect(browserEgress(current)).toEqual([]);
});
