import {
  access,
  mkdir,
  readFile,
  readdir,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "../src/cli/commands.js";
import { parseCliArgs } from "../src/cli/parser.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { remoteRolePaths, remoteStatePaths } from "../src/remote/paths.js";
import { RememberedHostStore } from "../src/remote/rememberedHosts.js";
import { derivePinnedHostId } from "../src/remote/gateway/originStore.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
const bytes16 = (value: number) => Buffer.alloc(16, value).toString("base64url");

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

type SeededCleanRoot = Awaited<ReturnType<typeof seedCleanRoot>>;

describe("waifus clean preserved remote trust", () => {
  it.each([
    ["host", 101],
    ["remote", 103]
  ] as const)("refuses before changing any file while the %s daemon is live", async (_role, livePid) => {
    const root = await makeTempRoot("waifus-remote-clean-running-");
    roots.push(root);
    await seedCleanRoot(root);
    silenceCli();
    const before = await snapshotFiles(root);

    const code = await runCommand(parseCliArgs(["clean", "--force", "--data-root", root]), {
      processAlive: (pid) => pid === livePid
    });

    expect(code).toBe(1);
    expect(await snapshotFiles(root)).toEqual(before);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("clean refused"));
  });

  it("deletes ordinary and transient state while preserving both roles' trust proof byte-for-byte", async () => {
    const root = await makeTempRoot("waifus-remote-clean-stopped-");
    roots.push(root);
    const seeded = await seedCleanRoot(root);
    silenceCli();

    const code = await runCommand(parseCliArgs(["clean", "--force", "--data-root", root]), {
      processAlive: () => false
    });

    expect(code).toBe(0);
    await expectPreserved(seeded);
    for (const filePath of seeded.deletedSentinels) await expectMissing(filePath);
    expect(await readFile(path.join(root, "config.toml"), "utf8"))
      .not.toContain("ordinary-config-must-be-replaced");
    expect(await readFile(seeded.paths.backendLog, "utf8")).toBe("backend-log\n");
    expect(await readFile(seeded.paths.hostLog, "utf8")).toBe("remote-host-log\n");
    expect(await readFile(seeded.paths.remoteGatewayLog, "utf8")).toBe("remote-gateway-log\n");
    expect(await readFile(seeded.unrelatedLog, "utf8")).toBe("unrelated-log\n");
    expect(await readFile(seeded.unrelatedRootFile, "utf8")).toBe("unrelated-root\n");
    expect(await readFile(seeded.unrelatedTmpFile, "utf8")).toBe("unrelated-tmp\n");
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("preserved 3 remote pairings")
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("local Settings → Remote Access")
    );
  });

  it("deletes only the known ordinary logs with --include-logs", async () => {
    const root = await makeTempRoot("waifus-remote-clean-logs-");
    roots.push(root);
    const seeded = await seedCleanRoot(root);
    silenceCli();
    const auditBefore = await readFile(seeded.auditFile, "utf8");

    const code = await runCommand(
      parseCliArgs(["clean", "--force", "--include-logs", "--data-root", root]),
      { processAlive: () => false }
    );

    expect(code).toBe(0);
    await expectMissing(seeded.paths.backendLog);
    await expectMissing(seeded.paths.hostLog);
    await expectMissing(seeded.paths.remoteGatewayLog);
    expect(await readFile(seeded.unrelatedLog, "utf8")).toBe("unrelated-log\n");
    expect(await readFile(seeded.auditFile, "utf8")).toBe(auditBefore);
  });

  it("refuses malformed remembered-host state without cleaning or repairing it", async () => {
    const root = await makeTempRoot("waifus-remote-clean-invalid-");
    roots.push(root);
    const seeded = await seedCleanRoot(root);
    await writeFile(seeded.paths.remoteRememberedHosts, "not-json\n", "utf8");
    silenceCli();
    const before = await snapshotFiles(root);

    const code = await runCommand(parseCliArgs(["clean", "--force", "--data-root", root]), {
      processAlive: () => false
    });

    expect(code).toBe(1);
    expect(await snapshotFiles(root)).toEqual(before);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("clean refused"));
  });
});

async function seedCleanRoot(root: string) {
  await ensureDataLayout(root);
  const paths = remoteStatePaths(root);
  const hostRole = remoteRolePaths(root, "host");
  const remoteRole = remoteRolePaths(root, "remote");

  const installation = JSON.parse(await readFile(paths.installation, "utf8")) as Record<string, unknown>;
  installation.activationReference = `waifus.activation.v1.${String(installation.installationId)}`;
  await writeJson(paths.installation, installation);
  await writeJson(paths.hostConfig, {
    revision: "7",
    enabled: true,
    displayName: "Studio Host",
    updatedAt: "9007199254740993"
  });
  await writeJson(paths.trustIndex, {
    version: 1,
    trustEpochHighWater: "12",
    resetTombstone: "4",
    pairs: [
      { deviceId: "travel-mac", pairId: bytes16(0x31), trustEpoch: "9" },
      { deviceId: "desk-linux", pairId: bytes16(0x32), trustEpoch: "12" }
    ]
  });

  const installationPublicKey = Buffer.alloc(32, 0x41);
  await new RememberedHostStore(root).upsert({
    version: 1,
    hostId: derivePinnedHostId(installationPublicKey),
    displayName: "Away Host",
    platform: { os: "linux", arch: "x64" },
    installationFingerprint: bytes16(0x42),
    trustEpoch: "6",
    revision: "3",
    pairedAt: "1786000000",
    lastSeenAt: "1786270800",
    lastDirectAt: "1786270800",
    connectionState: "offline",
    lastErrorCode: null,
    helperPairId: bytes16(0x43),
    installationPublicKey: installationPublicKey.toString("base64url")
  });

  const roleMetadata = [
    hostRole.helperRoleState,
    hostRole.helperRoleLock,
    hostRole.helperPairIndex,
    hostRole.helperPairJournal,
    hostRole.controlNonceState,
    hostRole.pairControlState,
    remoteRole.helperRoleState,
    remoteRole.helperRoleLock,
    remoteRole.helperPairIndex,
    remoteRole.helperPairJournal,
    remoteRole.controlNonceState,
    remoteRole.pairControlState
  ];
  for (const [index, filePath] of roleMetadata.entries()) {
    await writeText(filePath, `persistent-role-metadata-${index}\n`);
  }

  const operationFile = path.join(paths.operationsRoot, "ledger.json");
  const auditFile = path.join(paths.auditRoot, "ledger.json");
  const trustProofFile = path.join(paths.trustRoot, "pinned-public-bundles.json");
  const originFile = paths.remoteOriginState;
  const resetTombstone = paths.resetTombstone;
  const protectedVaultFile = path.join(root, "app", "helper-private", "protected-vault-sentinel");
  await writeText(operationFile, "operation-receipts\n");
  await writeText(auditFile, "administrative-audit\n");
  await writeText(trustProofFile, "trusted-device-public-proof\n");
  await writeText(originFile, "preserved-origin-high-water\n");
  await writeText(resetTombstone, "preserved-reset-tombstone\n");
  await writeText(protectedVaultFile, "helper-owned-private-state\n");

  const preservedFiles = [
    paths.hostConfig,
    paths.installation,
    paths.trustIndex,
    paths.remoteRememberedHosts,
    operationFile,
    auditFile,
    trustProofFile,
    originFile,
    resetTombstone,
    protectedVaultFile,
    ...roleMetadata
  ];
  const preserved = new Map<string, string>();
  for (const filePath of preservedFiles) preserved.set(filePath, await readFile(filePath, "utf8"));

  const ordinaryUser = path.join(root, "user", "ordinary-user-sentinel");
  const ordinaryCache = path.join(root, "app", "cache", "ordinary-cache-sentinel");
  const dashboardCache = path.join(paths.dashboardCacheRoot, "host", "build", "dashboard.js");
  const transientFiles = [
    path.join(paths.hostRuntimeRoot, "sessions", "browser.json"),
    path.join(paths.hostRuntimeRoot, "actions", "pending.json"),
    path.join(paths.hostRuntimeRoot, "invitations", "active.json"),
    path.join(paths.hostRuntimeRoot, "service.sock"),
    path.join(paths.remoteGatewayRuntimeRoot, "sessions", "browser.json"),
    path.join(paths.remoteGatewayRuntimeRoot, "actions", "pending.json"),
    path.join(paths.remoteGatewayRuntimeRoot, "invitations", "active.json"),
    path.join(paths.remoteGatewayRuntimeRoot, "parent.sock")
  ];
  await writeText(ordinaryUser, "ordinary-user\n");
  await writeText(path.join(root, "config.toml"), "ordinary-config-must-be-replaced\n");
  await writeText(ordinaryCache, "ordinary-cache\n");
  await writeText(dashboardCache, "verified-dashboard-cache\n");
  for (const [index, filePath] of transientFiles.entries()) {
    await writeText(filePath, `transient-${index}\n`);
  }
  await writeJson(paths.backendPid, { pid: 101 });
  await writeJson(paths.backendRuntime, { pid: 101, state: "transient" });
  await writeJson(paths.hostRuntimePid, { pid: 102 });
  await writeJson(paths.remoteGatewayRuntimePid, { pid: 103 });

  await writeText(paths.backendLog, "backend-log\n");
  await writeText(paths.hostLog, "remote-host-log\n");
  await writeText(paths.remoteGatewayLog, "remote-gateway-log\n");
  const unrelatedLog = path.join(root, "app", "logs", "plugin-owned.log");
  const unrelatedRootFile = path.join(root, "unrelated", "must-survive");
  const unrelatedTmpFile = path.join(root, "app", "tmp", "unrelated", "must-survive");
  await writeText(unrelatedLog, "unrelated-log\n");
  await writeText(unrelatedRootFile, "unrelated-root\n");
  await writeText(unrelatedTmpFile, "unrelated-tmp\n");

  return {
    root,
    paths,
    preserved,
    auditFile,
    unrelatedLog,
    unrelatedRootFile,
    unrelatedTmpFile,
    deletedSentinels: [ordinaryUser, ordinaryCache, dashboardCache, ...transientFiles]
  };
}

async function expectPreserved(seeded: SeededCleanRoot): Promise<void> {
  for (const [filePath, expected] of seeded.preserved) {
    expect(await readFile(filePath, "utf8"), filePath).toBe(expected);
  }
}

async function expectMissing(filePath: string): Promise<void> {
  await expect(access(filePath), filePath).rejects.toMatchObject({ code: "ENOENT" });
}

function silenceCli(): void {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
}

async function writeText(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function snapshotFiles(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(filePath);
      } else {
        snapshot[path.relative(root, filePath)] = (await readFile(filePath)).toString("base64");
      }
    }
  };
  await visit(root);
  return snapshot;
}
