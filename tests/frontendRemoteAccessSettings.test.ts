import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InvitationCard } from "../src/frontend/components/remoteAccess/InvitationCard.js";
import { PairingRequestCard } from "../src/frontend/components/remoteAccess/PairingRequestCard.js";
import { RemoteDiagnostics } from "../src/frontend/components/remoteAccess/RemoteDiagnostics.js";
import { TrustedDevices } from "../src/frontend/components/remoteAccess/TrustedDevices.js";
import {
  IDENTITY_RESET_CONFIRMATION,
  IdentityResetControl,
  identityResetConfirmationMatches
} from "../src/frontend/components/remoteAccess/IdentityResetControl.js";
import {
  formatHelperTarget,
  prohibitedTrafficIsZero
} from "../src/frontend/components/remoteAccess/presentation.js";
import { SECTION_TABS } from "../src/frontend/nav.js";
import type {
  PairInvitation,
  PendingPairingRequest,
  RemoteAccessDiagnostics as RemoteAccessDiagnosticsData,
  TrustedDevice
} from "../src/frontend/api/types.js";

const bytes16 = Buffer.alloc(16, 0x51).toString("base64url");
const bytes32 = Buffer.alloc(32, 0x61).toString("base64url");

function pendingPairing(): PendingPairingRequest {
  return {
    version: 1,
    requestId: bytes16,
    invitationId: Buffer.alloc(16, 0x52).toString("base64url"),
    invitationGeneration: "4",
    entryFlow: "full_token",
    claimedDisplayName: "Travel laptop",
    claimedPlatform: { os: "linux", arch: "arm", goarm: 7 },
    claimedInstallationFingerprint: Buffer.alloc(16, 0x53).toString("base64url"),
    remoteIdentityBundleHash: bytes32,
    expiresAt: "2",
    protocol: { major: 1, minor: 0 },
    transcriptHash: Buffer.alloc(32, 0x62).toString("base64url"),
    channelBinding: Buffer.alloc(32, 0x63).toString("base64url"),
    sasIndices: [1, 2, 3, 4, 5],
    sasWords: ["amber", "breeze", "coral", "drift", "ember"],
    sasFingerprint: "AB12-CD34-EF5"
  };
}

function trustedDevice(): TrustedDevice {
  return {
    version: 1,
    deviceId: "remote-device-1",
    displayName: "Travel laptop",
    platform: { os: "win32", arch: "x64" },
    installationFingerprint: bytes16,
    trustEpoch: "1",
    revision: "3",
    pairedAt: "1",
    lastSeenAt: null,
    connectionState: "direct"
  };
}

function diagnosticCounters(value = "0"): RemoteAccessDiagnosticsData {
  return {
    version: 1,
    appVersion: "1.5.203",
    dashboardBuildId: "a".repeat(64),
    helper: {
      state: "ready",
      version: "0.1.0",
      releaseSequence: "1",
      forkCommit: "a".repeat(40),
      target: { os: "darwin", arch: "arm64" },
      protocol: { major: 1, minor: 0 },
      capabilities: ["direct_tcp_v1"],
      secretStorage: "keychain"
    },
    controlState: "connected",
    stun: "available",
    udp: "available",
    portMapping: "available",
    directState: "direct",
    lastTransitionAt: "1",
    lastDirectAt: "1",
    lastErrorCode: null,
    prohibited: {
      derpRouteSelections: value,
      derpApplicationBytes: "0",
      peerRelayRouteSelections: "0",
      peerRelayApplicationBytes: "0",
      genericProxyRequests: "0",
      genericProxyBytes: "0"
    }
  };
}

describe("Remote Access settings presentation", () => {
  it("registers Remote Access as a settings tab", () => {
    expect(SECTION_TABS.settings).toContainEqual({ id: "remote-access", label: "Remote Access" });
  });

  it("shows invitation secrets as copyable text without turning them into links", () => {
    const invitation: PairInvitation = {
      invitationId: bytes16,
      fullToken: `WF1.${Buffer.from("private invitation").toString("base64url")}`,
      shortCode: "ABCD-EFGH",
      expiresAt: "2"
    };
    const html = renderToStaticMarkup(createElement(InvitationCard, {
      invitation,
      onCancel: async () => undefined,
      onMessage: () => undefined
    }));

    expect(html).toContain(invitation.fullToken);
    expect(html).toContain("ABCD-EFGH");
    expect(html).toContain("<svg");
    expect(html).toContain("shape-rendering=\"crispEdges\"");
    expect(html).toContain("approval on an already trusted dashboard is still required");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("data:image");
    expect(html).not.toContain("localStorage");
  });

  it("requires an explicit comparison before a pairing can be approved", () => {
    const html = renderToStaticMarkup(createElement(PairingRequestCard, {
      request: pendingPairing(),
      onApprove: async () => undefined,
      onReject: async () => undefined
    }));

    expect(html).toContain("amber breeze coral drift ember");
    expect(html).toContain("AB12-CD34-EF5");
    expect(html).toContain("both the words and fingerprint");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Approve device<\/button>/);
    expect(html).toContain("Linux armv7");
  });

  it("keeps revocation behind a typed confirmation that is closed by default", () => {
    const html = renderToStaticMarkup(createElement(TrustedDevices, {
      devices: [trustedDevice()],
      onRename: async () => undefined,
      onRevoke: async () => undefined
    }));

    expect(html).toContain("Travel laptop");
    expect(html).toContain("Revoke");
    expect(html).not.toContain("Confirm revoke");
  });

  it("keeps identity rotation behind the exact local-only typed confirmation", () => {
    expect(identityResetConfirmationMatches(IDENTITY_RESET_CONFIRMATION)).toBe(true);
    expect(identityResetConfirmationMatches("reset remote access")).toBe(false);
    expect(identityResetConfirmationMatches(`${IDENTITY_RESET_CONFIRMATION} `)).toBe(false);

    const local = renderToStaticMarkup(createElement(IdentityResetControl, {
      mode: "host",
      busy: false,
      onReset: async () => undefined
    }));
    expect(local).toContain(`Type ${IDENTITY_RESET_CONFIRMATION} to confirm`);
    expect(local).toMatch(/<button[^>]*disabled=""[^>]*>Reset identity<\/button>/);
    expect(local).not.toContain("not connected in this build");

    const remote = renderToStaticMarkup(createElement(IdentityResetControl, {
      mode: "remote",
      busy: false,
      onReset: async () => undefined
    }));
    expect(remote).toContain("Identity reset is local-only");
    expect(remote).not.toContain(`aria-label="Type ${IDENTITY_RESET_CONFIRMATION} to confirm"`);
  });

  it("makes the direct-only prohibited counters prominent and never renders endpoints", () => {
    const clear = diagnosticCounters();
    const failed = diagnosticCounters("1");
    expect(prohibitedTrafficIsZero(clear)).toBe(true);
    expect(prohibitedTrafficIsZero(failed)).toBe(false);
    expect(formatHelperTarget({ os: "linux", arch: "arm", goarm: 7 })).toBe("Linux armv7");

    const html = renderToStaticMarkup(createElement(RemoteDiagnostics, { diagnostics: clear }));
    expect(html).toContain("relay counters clear");
    expect(html).toContain("These counters must remain zero");
    expect(html).not.toContain("198.51.100.");
  });
});
