import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const nativeStorage = Object.freeze({
  darwin: "keychain",
  win32: "windows_protected_storage",
  linux: "secret_service"
});
const targets = new Set(["darwin/arm64", "win32/x64", "win32/arm64", "linux/x64", "linux/arm64"]);
const plainVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

function fail() {
  throw new Error("Remote helper native smoke failed.");
}

export function assertNativeHelperState(supervisor, platform, arch, expectedHelperVersion) {
  const snapshot = supervisor.snapshot();
  const identity = supervisor.identityStatus();
  if (!targets.has(`${platform}/${arch}`)
    || snapshot.state !== "ready"
    || snapshot.target?.os !== platform || snapshot.target?.arch !== arch
    || snapshot.helperVersion !== expectedHelperVersion
    || snapshot.lastErrorCode !== null || snapshot.restartScheduled
    || snapshot.runtimeStatus.activationState !== "activation_required"
    || snapshot.runtimeStatus.controlState !== "inactive"
    || snapshot.runtimeStatus.directState !== "inactive"
    || !identity || identity.secretStorage !== nativeStorage[platform]
    || identity.activationState !== "activation_required"
    || typeof identity.deviceId !== "string" || !identity.deviceId
    || typeof identity.installationFingerprint !== "string" || !identity.installationFingerprint) fail();
  return identity;
}

export function assertSameIdentity(first, second) {
  if (first.deviceId !== second.deviceId
    || first.installationFingerprint !== second.installationFingerprint
    || first.secretStorage !== second.secretStorage) fail();
}

export async function closeNativeHelper(supervisor, record) {
  if (!record || record.closeRequestedAt !== null) fail();
  record.closeRequestedAt = Date.now();
  let timer;
  try {
    const [, exit] = await Promise.race([
      Promise.all([supervisor.close(), record.exited]),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Remote helper native smoke failed.")), 5_000);
      })
    ]);
    // ts-connect 0.1.2 deliberately returns 70 after losing its parent session/pipe,
    // including the parent's intentional close. Its supervised.go drains the router
    // before returning; supervised_unix_integration_test.go explicitly requires 70.
    // Accept this only after our close request, with a bounded exit and no forced kill.
    if (record.forced || !exit.intentionalClose || exit.closeElapsedMs > 5_000
      || ![0, 70].includes(exit.code) || exit.signal !== null
      || supervisor.snapshot().state !== "disabled" || supervisor.snapshot().restartScheduled) fail();
  } finally {
    clearTimeout(timer);
  }
}

/** Exercise the installed app's production resolver and authenticated native process. */
export async function smokeInstalledHelper(packageRoot, platform, arch) {
  // Check the real Node process before importing or executing any package code.
  if (process.platform !== platform || process.arch !== arch || !targets.has(`${platform}/${arch}`)) fail();
  const root = path.resolve(packageRoot);
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (!plainVersion.test(pkg.version)
    || !["@waifucave/discord-waifus", "@starlight-ai/discord-waifus"].includes(pkg.name)) fail();
  const helperVersion = pkg.optionalDependencies?.[`@waifucave/ts-connect-${platform}-${arch}`];
  if (typeof helperVersion !== "string" || !plainVersion.test(helperVersion)) fail();
  const importInstalled = (relative) => import(pathToFileURL(path.join(root, relative)).href);
  const [{ createProductionHelperSupervisor }, { ProtectedHelperProcessFactory },
    { loadRemoteCompatibilityV1 }, { ensureRemoteOnlyLayout }] = await Promise.all([
    importInstalled("dist/remote/productionHelper.js"),
    importInstalled("dist/remote/helperClient.js"),
    importInstalled("dist/remote/componentCompatibility.js"),
    importInstalled("dist/config/layout.js")
  ]);
  await loadRemoteCompatibilityV1(pkg.version, path.join(root, "remote-compatibility.json"));
  // A short real Unix path keeps the protected socket below macOS's 103-byte limit.
  const dataRoot = await mkdtemp(path.join(platform === "win32" ? os.tmpdir() : "/tmp", "wh-"));
  const logger = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });
  let supervisor;
  const launches = [];
  const nativeFactory = new ProtectedHelperProcessFactory();
  const processFactory = {
    async launch(request) {
      if (request.parentHello.controlProfile !== 1 || request.parentHello.runtimePurpose !== "normal") fail();
      const launch = await nativeFactory.launch(request);
      const record = { forced: false, closeRequestedAt: null, exited: null };
      record.exited = launch.exited.then((exit) => ({
        ...exit,
        intentionalClose: record.closeRequestedAt !== null,
        closeElapsedMs: record.closeRequestedAt === null ? null : Date.now() - record.closeRequestedAt
      }));
      launches.push(record);
      return { ...launch, forceTerminate() { record.forced = true; return launch.forceTerminate(); } };
    }
  };
  try {
    await ensureRemoteOnlyLayout(dataRoot);
    const create = () => createProductionHelperSupervisor({
      role: "remote", dataRoot, appVersion: pkg.version, buildId: "native-release-smoke",
      logger, processFactory, compatibilityFilePath: path.join(root, "remote-compatibility.json")
    });
    supervisor = await create();
    await supervisor.start();
    const first = assertNativeHelperState(supervisor, platform, arch, helperVersion);
    await closeNativeHelper(supervisor, launches.at(-1));
    supervisor = await create();
    await supervisor.start();
    const second = assertNativeHelperState(supervisor, platform, arch, helperVersion);
    assertSameIdentity(first, second);
    await closeNativeHelper(supervisor, launches.at(-1));
    if (launches.length !== 2) fail();
    return { version: pkg.version, helperVersion, platform, arch, pass: true };
  } finally {
    await supervisor?.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 5) fail();
    const result = await smokeInstalledHelper(...process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write("Remote helper native smoke failed.\n");
    process.exitCode = 1;
  }
}
