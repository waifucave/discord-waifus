import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "smol-toml";
import { z } from "zod";
import { DEFAULT_APP_CONFIG } from "../shared/schemas/config.js";
import { CURRENT_SCHEMA_VERSION, createRevisionedBase } from "../shared/schemas/common.js";
import { WaifuConfigSchema } from "../shared/schemas/domain.js";
import {
  RemoteAccessInstallationStateV1Schema,
  RemoteAccessTrustIndexV1Schema
} from "../shared/schemas/remoteAccess.js";
import { RemoteAccessConfigV1Schema } from "../shared/schemas/remoteLifecycle.js";
import { remoteStatePaths } from "../remote/paths.js";
import { resolveDataPath } from "./paths.js";
import { PREBUILT_WAIFUS } from "./prebuiltWaifus.js";

export const DATA_LAYOUT_DIRS = [
  "app",
  "app/logs",
  "app/cache",
  "app/cache/ocr",
  "app/cache/ocr/bin",
  "app/cache/ocr/results",
  "app/cache/remote-dashboard",
  "app/tmp",
  "app/tmp/ocr",
  "app/tmp/remote-host",
  "app/tmp/remote-gateway",
  "app/tmp/swift-module-cache",
  "app/remote-access",
  "app/remote-access/trust",
  "app/remote-access/operations",
  "app/remote-access/audit",
  "app/remote-gateway",
  "user",
  "user/memory",
  "user/waifus",
  "user/orchestrator",
  "user/stage-manager",
  "user/reviewer",
  "user/assistant",
  "user/servers"
] as const;

const DEFAULT_JSON_FILES: Array<{ relativePath: string; content: unknown }> = [
  {
    relativePath: "user/providers.json",
    content: {
      ...createRevisionedBase(),
      providers: {}
    }
  },
  {
    relativePath: "user/discord-bots.json",
    content: {
      ...createRevisionedBase(),
      orchestrator: null,
      waifus: []
    }
  },
  {
    relativePath: "user/orchestrator/config.json",
    content: {
      ...createRevisionedBase(),
      enabled: false,
      contextWindow: 20,
      prompt: ""
    }
  },
  {
    relativePath: "user/orchestrator/history.json",
    content: {
      ...createRevisionedBase(),
      decisions: []
    }
  },
  {
    relativePath: "user/orchestrator/debug.json",
    content: {
      ...createRevisionedBase(),
      routes: {}
    }
  },
  {
    relativePath: "user/stage-manager/config.json",
    content: {
      ...createRevisionedBase(),
      enabled: false,
      contextWindow: 80,
      prompt: ""
    }
  },
  {
    relativePath: "user/stage-manager/history.json",
    content: {
      ...createRevisionedBase(),
      edits: []
    }
  },
  {
    relativePath: "user/reviewer/config.json",
    content: {
      ...createRevisionedBase(),
      enabled: false,
      contextWindow: 20,
      prompt: ""
    }
  },
  {
    relativePath: "user/reviewer/history.json",
    content: {
      ...createRevisionedBase(),
      reviews: []
    }
  }
];

// Not a version-literal: this marker only gates "have we already seeded the prebuilt waifus?" —
// an older schemaVersion here must not make ensureDataLayout throw on every boot for existing
// installs (it runs before runMigrations gets a chance to fix anything). runMigrations' boot
// migration stamps this file's schemaVersion forward separately.
const PrebuiltWaifuSeedMarkerSchema = z.object({
  schemaVersion: z.number().int().nonnegative(),
  seededAt: z.string().datetime({ offset: true }),
  waifuIds: z.array(z.string())
});

export async function ensureDataLayout(dataRoot: string): Promise<void> {
  await mkdir(dataRoot, { recursive: true });
  await Promise.all(DATA_LAYOUT_DIRS.map((dir) => mkdir(resolveDataPath(dataRoot, dir), { recursive: true })));

  await ensureRemoteAccessLayout(dataRoot);

  await writeIfMissing(
    resolveDataPath(dataRoot, "config.toml"),
    stringify(DEFAULT_APP_CONFIG) + "\n"
  );

  await Promise.all(
    DEFAULT_JSON_FILES.map((file) =>
      writeJsonIfMissing(resolveDataPath(dataRoot, file.relativePath), file.content)
    )
  );

  await seedPrebuiltWaifusOnce(dataRoot);
}

export class RemoteStateRepairRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteStateRepairRequiredError";
  }
}

async function ensureRemoteAccessLayout(dataRoot: string): Promise<void> {
  const paths = remoteStatePaths(dataRoot);
  await Promise.all([
    paths.hostStateRoot,
    paths.trustRoot,
    paths.operationsRoot,
    paths.auditRoot,
    paths.remoteGatewayStateRoot,
    paths.dashboardCacheRoot,
    paths.hostRuntimeRoot,
    paths.remoteGatewayRuntimeRoot
  ].map(async (directory) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new RemoteStateRepairRequiredError(
        `Remote state directory is not an owned regular directory: ${directory}`
      );
    }
    await chmod(directory, 0o700);
  }));

  const [hasConfig, hasInstallation, trustEntries, gatewayEntries] = await Promise.all([
    fileExists(paths.hostConfig),
    fileExists(paths.installation),
    readdir(paths.trustRoot),
    readdir(paths.remoteGatewayStateRoot)
  ]);
  const trustWithoutIndex = trustEntries.filter((entry) => entry !== "index.json");

  if (!hasInstallation && (hasConfig || trustWithoutIndex.length > 0 || gatewayEntries.length > 0)) {
    throw new RemoteStateRepairRequiredError(
      "Remote installation metadata is missing while preserved remote state exists; repair is required."
    );
  }
  if (!hasInstallation) {
    const installationId = randomBytes(16).toString("base64url");
    await writeJsonIfMissing(paths.installation, RemoteAccessInstallationStateV1Schema.parse({
      version: 1,
      installationId,
      vaultLabel: `waifus.installation.v1.${installationId}`,
      activationReference: null,
      createdAt: Date.now().toString(10)
    }));
  }

  if (!trustEntries.includes("index.json")) {
    if (trustWithoutIndex.length > 0) {
      throw new RemoteStateRepairRequiredError(
        "Remote trust index is missing while pair/trust metadata exists; repair is required."
      );
    }
    await writeJsonIfMissing(paths.trustIndex, RemoteAccessTrustIndexV1Schema.parse({
      version: 1,
      trustEpochHighWater: "0",
      resetTombstone: "0",
      pairs: []
    }));
  }

  if (!hasConfig) {
    await writeJsonIfMissing(paths.hostConfig, RemoteAccessConfigV1Schema.parse({
      revision: "0",
      enabled: false,
      displayName: "Discord Waifus Host",
      updatedAt: Date.now().toString(10)
    }));
  }
  await Promise.all([
    paths.hostConfig,
    paths.installation,
    paths.trustIndex
  ].map(assertOwnedRegularFile));
}

export async function readPackageVersion(): Promise<string> {
  try {
    const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const raw = await readFile(packagePath, "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function writeJsonIfMissing(filePath: string, content: unknown): Promise<void> {
  await writeIfMissing(filePath, JSON.stringify(content, null, 2) + "\n");
}

async function seedPrebuiltWaifusOnce(dataRoot: string): Promise<void> {
  const markerPath = resolveDataPath(dataRoot, "user", "waifus", ".prebuilt-seed.json");
  try {
    const raw = await readFile(markerPath, "utf8");
    PrebuiltWaifuSeedMarkerSchema.parse(JSON.parse(raw));
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await Promise.all(
    PREBUILT_WAIFUS.map((waifu) =>
      writeJsonIfMissing(
        resolveDataPath(dataRoot, "user", "waifus", waifu.id, "waifu.json"),
        WaifuConfigSchema.parse({
          ...createRevisionedBase(),
          ...waifu
        })
      )
    )
  );

  await writeJsonIfMissing(markerPath, {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    seededAt: new Date().toISOString(),
    waifuIds: PREBUILT_WAIFUS.map((waifu) => waifu.id)
  });
}

async function writeIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    await mkdir(path.dirname(filePath), { recursive: true });
    let handle;
    try {
      handle = await open(filePath, "wx", 0o600);
    } catch (openError) {
      if ((openError as NodeJS.ErrnoException).code === "EEXIST") return;
      throw openError;
    }
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new RemoteStateRepairRequiredError(
        `Remote state file is not an owned regular file: ${filePath}`
      );
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertOwnedRegularFile(filePath: string): Promise<void> {
  const info = await lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new RemoteStateRepairRequiredError(
      `Remote state file is not an owned regular file: ${filePath}`
    );
  }
}

export function runtimeFileDefaults(dataRoot: string, packageVersion: string, port: number, mode: string) {
  const now = new Date().toISOString();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    pid: process.pid,
    startedAt: now,
    updatedAt: now,
    packageVersion,
    port,
    dataRoot,
    mode
  };
}
