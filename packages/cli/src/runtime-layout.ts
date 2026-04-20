import { promises as fs } from "node:fs";
import path from "node:path";
import { stringify } from "smol-toml";

export interface RuntimeLayoutPaths {
  defaultsRoot: string;
  runtimeRoot: string;
  runtimeConfigFile: string;
  runtimeProvidersFile: string;
  runtimeKeysFile: string;
  runtimeChannelsFile: string;
  runtimeOrchestratorFile: string;
  runtimeStageManagerFile: string;
  runtimeWaifusRoot: string;
  runtimeStageManagerDataRoot: string;
  runtimeAssetsWaifusRoot: string;
  runtimeStateRoot: string;
  migrationStateFile: string;
  migrationWarningsFile: string;
  stageManagerCheckpointsFile: string;
  defaultsConfigFile: string;
  defaultsChannelsFile: string;
  defaultsOrchestratorFile: string;
  defaultsStageManagerFile: string;
  defaultsProviderCatalogFile: string;
  defaultsWaifuTemplateFile: string;
  legacyConfigRoot: string;
  legacyDataRoot: string;
  legacyWaifusFile: string;
  legacyProvidersFile: string;
  legacyChannelsFile: string;
  legacyOrchestratorFile: string;
  legacyStageManagerFile: string;
  legacyStageManagerStateFile: string;
}

export interface MigrationStateFile {
  schemaVersion: number;
  status: "bootstrap_empty" | "import_completed";
  createdAt: string;
  completedAt: string;
}

export interface RuntimeStateInspection {
  paths: RuntimeLayoutPaths;
  runtimeRootExists: boolean;
  legacyLiveExists: boolean;
  migrationState: MigrationStateFile | null;
  isCanonicalLocalRuntime: boolean;
  isMigrationPending: boolean;
}

export function getRuntimeLayoutPaths(projectRoot: string): RuntimeLayoutPaths {
  const defaultsRoot = path.join(projectRoot, "defaults");
  const runtimeRoot = path.join(projectRoot, ".waifus");
  const runtimeStateRoot = path.join(runtimeRoot, "state");
  const legacyConfigRoot = path.join(projectRoot, "config");
  const legacyDataRoot = path.join(projectRoot, "data");

  return {
    defaultsRoot,
    runtimeRoot,
    runtimeConfigFile: path.join(runtimeRoot, "config.toml"),
    runtimeProvidersFile: path.join(runtimeRoot, "providers.toml"),
    runtimeKeysFile: path.join(runtimeRoot, "keys.toml"),
    runtimeChannelsFile: path.join(runtimeRoot, "channels.toml"),
    runtimeOrchestratorFile: path.join(runtimeRoot, "orchestrator.toml"),
    runtimeStageManagerFile: path.join(runtimeRoot, "stage-manager.toml"),
    runtimeWaifusRoot: path.join(runtimeRoot, "waifus"),
    runtimeStageManagerDataRoot: path.join(runtimeRoot, "stage-manager-data"),
    runtimeAssetsWaifusRoot: path.join(runtimeRoot, "assets", "waifus"),
    runtimeStateRoot,
    migrationStateFile: path.join(runtimeStateRoot, "migration-state.json"),
    migrationWarningsFile: path.join(runtimeStateRoot, "migration-warnings.json"),
    stageManagerCheckpointsFile: path.join(runtimeStateRoot, "stage-manager-checkpoints.json"),
    defaultsConfigFile: path.join(defaultsRoot, "config.toml"),
    defaultsChannelsFile: path.join(defaultsRoot, "channels.toml"),
    defaultsOrchestratorFile: path.join(defaultsRoot, "orchestrator.toml"),
    defaultsStageManagerFile: path.join(defaultsRoot, "stage-manager.toml"),
    defaultsProviderCatalogFile: path.join(defaultsRoot, "providers.catalog.json"),
    defaultsWaifuTemplateFile: path.join(defaultsRoot, "waifus", "default-waifu.json"),
    legacyConfigRoot,
    legacyDataRoot,
    legacyWaifusFile: path.join(legacyConfigRoot, "waifus.json"),
    legacyProvidersFile: path.join(legacyConfigRoot, "providers.json"),
    legacyChannelsFile: path.join(legacyConfigRoot, "channels.json"),
    legacyOrchestratorFile: path.join(legacyConfigRoot, "orchestrator.json"),
    legacyStageManagerFile: path.join(legacyConfigRoot, "stage-manager.json"),
    legacyStageManagerStateFile: path.join(legacyDataRoot, "stage-manager-state.json")
  };
}

export async function inspectRuntimeState(projectRoot: string): Promise<RuntimeStateInspection> {
  const paths = getRuntimeLayoutPaths(projectRoot);
  const runtimeRootExists = await fileExists(paths.runtimeRoot);
  const legacyLiveExists = await hasLegacyLiveConfig(projectRoot);
  const migrationState = await readMigrationState(paths.migrationStateFile);
  const isCanonicalLocalRuntime =
    Boolean(runtimeRootExists) &&
    (
      migrationState?.status === "import_completed" ||
      (migrationState?.status === "bootstrap_empty" && !legacyLiveExists) ||
      (!migrationState && !legacyLiveExists)
    );

  return {
    paths,
    runtimeRootExists,
    legacyLiveExists,
    migrationState,
    isCanonicalLocalRuntime,
    isMigrationPending: Boolean(runtimeRootExists && legacyLiveExists && migrationState?.status !== "import_completed")
  };
}

export async function hasLegacyLiveConfig(projectRoot: string): Promise<boolean> {
  const paths = getRuntimeLayoutPaths(projectRoot);
  const candidates = [
    paths.legacyWaifusFile,
    paths.legacyProvidersFile,
    paths.legacyChannelsFile,
    paths.legacyOrchestratorFile,
    paths.legacyStageManagerFile,
    paths.legacyStageManagerStateFile
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return true;
    }
  }

  return false;
}

export async function bootstrapLocalRuntime(projectRoot: string): Promise<string[]> {
  const inspection = await inspectRuntimeState(projectRoot);
  if (inspection.legacyLiveExists && inspection.migrationState?.status !== "import_completed") {
    throw new Error("Legacy live config still exists. Run: waifus migrate-local-config");
  }

  return seedLocalRuntimeFromDefaults(projectRoot, {
    writeBootstrapMigrationState: !inspection.migrationState && !inspection.legacyLiveExists
  });
}

export async function seedLocalRuntimeFromDefaults(
  projectRoot: string,
  options: { writeBootstrapMigrationState: boolean }
): Promise<string[]> {
  const inspection = await inspectRuntimeState(projectRoot);

  const paths = inspection.paths;
  const written: string[] = [];

  await Promise.all([
    fs.mkdir(paths.runtimeWaifusRoot, { recursive: true }),
    fs.mkdir(paths.runtimeStageManagerDataRoot, { recursive: true }),
    fs.mkdir(paths.runtimeAssetsWaifusRoot, { recursive: true }),
    fs.mkdir(paths.runtimeStateRoot, { recursive: true })
  ]);

  written.push(
    await ensureCopied(paths.defaultsConfigFile, paths.runtimeConfigFile),
    await ensureCopied(paths.defaultsChannelsFile, paths.runtimeChannelsFile),
    await ensureSeededProviders(paths.defaultsProviderCatalogFile, paths.runtimeProvidersFile),
    await ensureFile(paths.runtimeKeysFile, `${stringify({ provider_keys: [] })}\n`),
    await ensureCopied(paths.defaultsOrchestratorFile, paths.runtimeOrchestratorFile),
    await ensureCopied(paths.defaultsStageManagerFile, paths.runtimeStageManagerFile),
    await ensureJsonFile(paths.stageManagerCheckpointsFile, { guilds: {} }),
    await ensureJsonFile(paths.migrationWarningsFile, {
      schemaVersion: 1,
      globalWarnings: [],
      waifuWarnings: {}
    })
  );

  if (options.writeBootstrapMigrationState) {
    written.push(
      await ensureJsonFile(paths.migrationStateFile, {
        schemaVersion: 1,
        status: "bootstrap_empty",
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString()
      })
    );
  }

  return written.filter(Boolean);
}

export function defaultSeedFiles(projectRoot: string): string[] {
  const paths = getRuntimeLayoutPaths(projectRoot);
  return [
    paths.defaultsConfigFile,
    paths.defaultsChannelsFile,
    paths.defaultsOrchestratorFile,
    paths.defaultsStageManagerFile,
    paths.defaultsProviderCatalogFile,
    paths.defaultsWaifuTemplateFile
  ];
}

export function localRuntimeFiles(projectRoot: string): string[] {
  const paths = getRuntimeLayoutPaths(projectRoot);
  return [
    paths.runtimeConfigFile,
    paths.runtimeProvidersFile,
    paths.runtimeKeysFile,
    paths.runtimeChannelsFile,
    paths.runtimeOrchestratorFile,
    paths.runtimeStageManagerFile,
    paths.migrationStateFile,
    paths.migrationWarningsFile,
    paths.stageManagerCheckpointsFile
  ];
}

async function ensureSeededProviders(catalogFile: string, providersFile: string): Promise<string> {
  if (await fileExists(providersFile)) {
    return "";
  }

  const catalog = JSON.parse(await fs.readFile(catalogFile, "utf8")) as {
    providers?: Array<{
      id: string;
      name: string;
      type: string;
      authMode?: string;
      enabledByDefault?: boolean;
      baseUrl: string;
      models?: string[];
    }>;
  };
  const tomlValue = {
    providers: (catalog.providers ?? []).map((entry) => ({
      id: entry.id,
      origin: "built-in",
      name: entry.name,
      type: entry.type,
      auth_mode: entry.authMode ?? "required",
      enabled: entry.enabledByDefault ?? false,
      base_url: entry.baseUrl,
      models: entry.models ?? []
    }))
  };
  await fs.mkdir(path.dirname(providersFile), { recursive: true });
  await fs.writeFile(providersFile, `${stringify(tomlValue)}\n`, "utf8");
  return providersFile;
}

async function ensureCopied(sourceFile: string, targetFile: string): Promise<string> {
  if (await fileExists(targetFile)) {
    return "";
  }

  const contents = await fs.readFile(sourceFile, "utf8");
  await fs.mkdir(path.dirname(targetFile), { recursive: true });
  await fs.writeFile(targetFile, contents, "utf8");
  return targetFile;
}

async function ensureFile(targetFile: string, contents: string): Promise<string> {
  if (await fileExists(targetFile)) {
    return "";
  }

  await fs.mkdir(path.dirname(targetFile), { recursive: true });
  await fs.writeFile(targetFile, contents, "utf8");
  return targetFile;
}

async function ensureJsonFile(targetFile: string, value: unknown): Promise<string> {
  return ensureFile(targetFile, `${JSON.stringify(value, null, 2)}\n`);
}

async function readMigrationState(filePath: string): Promise<MigrationStateFile | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as MigrationStateFile;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
