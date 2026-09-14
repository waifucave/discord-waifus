import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RemoteConnectionBanner } from "../src/frontend/components/RemoteConnectionBanner.js";
import { ContextExternalLinkView } from "../src/frontend/components/ContextExternalLink.js";
import {
  ClientContextProvider,
  parseClientContext,
  remoteConnectionPresentation
} from "../src/frontend/state/clientContext.js";
import { RemoteAccessStore } from "../src/frontend/state/remoteAccessStore.js";
import type { RemoteAccessStatus } from "../src/frontend/api/types.js";

const selectedHostId = Buffer.alloc(32, 0x61).toString("base64url");
const connectionShellOrigin = `http://waifus-${"a".repeat(52)}.localhost:43123`;

function remoteContext(connectionState: "direct" | "reconnecting" | "direct_unavailable") {
  return {
    mode: "remote" as const,
    selectedHostId,
    connectionState,
    connectionShellOrigin
  };
}

function remoteStatus(
  dashboardBuildId: string,
  overrides: Partial<RemoteAccessStatus> = {}
): RemoteAccessStatus {
  return {
    version: 1,
    config: {
      revision: "0",
      enabled: true,
      displayName: "Studio Host",
      updatedAt: "100"
    },
    identity: {
      deviceId: "host-device-01",
      installationFingerprint: Buffer.alloc(16, 0x51).toString("base64url")
    },
    appVersion: "1.5.203",
    dashboardBuildId,
    helperVersion: "0.1.0",
    helperReleaseSequence: "42",
    protocol: { major: 1, minor: 0 },
    capabilities: ["direct_tcp_v1"],
    helperState: "ready",
    activationState: "active",
    controlState: "connected",
    directState: "direct",
    lastDirectAt: "100",
    lastErrorCode: null,
    ...overrides
  };
}

describe("frontend client context", () => {
  it("accepts only the exact host and remote context fields", () => {
    expect(parseClientContext({ mode: "host" })).toEqual({ mode: "host" });
    expect(parseClientContext(remoteContext("direct"))).toEqual(remoteContext("direct"));

    for (const value of [
      { ...remoteContext("direct"), dataRoot: "/private/host" },
      { ...remoteContext("direct"), endpoint: "198.51.100.2:443" },
      { ...remoteContext("direct"), bootstrapToken: Buffer.alloc(32, 0x62).toString("base64url") },
      { ...remoteContext("direct"), connectionShellOrigin: "https://pair.waifucave.com" },
      { ...remoteContext("direct"), selectedHostId: "short" }
    ]) {
      expect(() => parseClientContext(value)).toThrow(TypeError);
    }
  });

  it.each([
    ["direct", "Connected directly", "ok"],
    ["reconnecting", "Reconnecting", "warn"],
    ["direct_unavailable", "Direct connection unavailable", "err"]
  ] as const)("maps %s to a stable connection presentation", (connectionState, label, tone) => {
    expect(remoteConnectionPresentation(remoteContext(connectionState))).toEqual({
      label,
      tone,
      connectionShellOrigin
    });
  });

  it("renders the shell origin as copy-only text with recovery guidance", () => {
    const html = renderToStaticMarkup(createElement(RemoteConnectionBanner, {
      context: remoteContext("reconnecting")
    }));

    expect(html).toContain("Reconnecting");
    expect(html).toContain(connectionShellOrigin);
    expect(html).toContain("browser Back");
    expect(html).toContain("waifus remote");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("bootstrap");
  });

  it("renders no remote banner in host mode", () => {
    expect(renderToStaticMarkup(createElement(RemoteConnectionBanner, {
      context: { mode: "host" }
    }))).toBe("");
  });

  it("does not mount dashboard controls before client context is established", () => {
    const html = renderToStaticMarkup(createElement(
      ClientContextProvider,
      { loadContext: async () => ({ mode: "host" }) },
      createElement("button", null, "Privileged control")
    ));

    expect(html).toContain("Establishing dashboard session");
    expect(html).not.toContain("Privileged control");
  });
});

describe("remote-access state store", () => {
  it("replaces state from an authoritative snapshot after a cursor reset", () => {
    const store = new RemoteAccessStore(async () => remoteStatus("a".repeat(64)));
    const context = remoteContext("direct");
    store.applySnapshot(context, remoteStatus("a".repeat(64), {
      capabilities: ["direct_tcp_v1", "port_mapping_v1"],
      controlState: "connected"
    }));

    store.applySnapshot(context, remoteStatus("a".repeat(64), {
      capabilities: [],
      controlState: "reconnecting",
      directState: "reconnecting"
    }));

    expect(store.get()).toMatchObject({
      sourceEpoch: 1,
      loading: false,
      status: {
        capabilities: [],
        controlState: "reconnecting",
        directState: "reconnecting"
      }
    });
  });

  it("resets on a selected-host change and advances on a dashboard build switch", () => {
    const store = new RemoteAccessStore(async () => remoteStatus("a".repeat(64)));
    const firstContext = remoteContext("direct");
    store.applySnapshot(firstContext, remoteStatus("a".repeat(64)));

    const otherContext = {
      ...firstContext,
      selectedHostId: Buffer.alloc(32, 0x62).toString("base64url")
    };
    store.setContext(otherContext);
    expect(store.get()).toMatchObject({ sourceEpoch: 2, status: undefined });

    store.applySnapshot(otherContext, remoteStatus("a".repeat(64)));
    expect(store.get().sourceEpoch).toBe(2);
    store.applySnapshot(otherContext, remoteStatus("b".repeat(64)));
    expect(store.get()).toMatchObject({
      sourceEpoch: 3,
      dashboardBuildId: "b".repeat(64),
      status: { identity: { deviceId: "host-device-01" } }
    });
  });

  it("aborts and ignores a stale request when the selected host changes", async () => {
    const pending: Array<{
      signal: AbortSignal;
      resolve: (status: RemoteAccessStatus) => void;
    }> = [];
    const store = new RemoteAccessStore((signal) => new Promise((resolve) => {
      pending.push({ signal, resolve });
    }));
    const firstContext = remoteContext("direct");
    const first = store.refresh(firstContext);
    await Promise.resolve();

    const otherContext = {
      ...firstContext,
      selectedHostId: Buffer.alloc(32, 0x63).toString("base64url")
    };
    const second = store.refresh(otherContext);
    await Promise.resolve();

    expect(pending[0].signal.aborted).toBe(true);
    pending[1].resolve(remoteStatus("c".repeat(64)));
    await second;
    pending[0].resolve(remoteStatus("a".repeat(64)));
    await first;

    expect(store.get()).toMatchObject({
      contextKey: `remote:${otherContext.selectedHostId}`,
      dashboardBuildId: "c".repeat(64)
    });
  });
});

describe("context-aware external links", () => {
  it("keeps host links clickable and makes remote links copy-only", () => {
    const url = "https://example.com/provider-docs";
    const hostHtml = renderToStaticMarkup(createElement(ContextExternalLinkView, {
      context: { mode: "host" },
      href: url,
      children: "Provider docs"
    }));
    const remoteHtml = renderToStaticMarkup(createElement(ContextExternalLinkView, {
      context: remoteContext("direct"),
      href: url,
      children: "Provider docs"
    }));

    expect(hostHtml).toContain(`href="${url}"`);
    expect(hostHtml).toContain("target=\"_blank\"");
    expect(remoteHtml).toContain(url);
    expect(remoteHtml).toContain("Copy this URL");
    expect(remoteHtml).not.toContain("href=");
    expect(remoteHtml).not.toContain("target=");
  });
});
