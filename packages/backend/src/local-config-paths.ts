import path from "node:path";

export class LocalConfigPaths {
  readonly workspaceRoot: string;
  readonly defaultsRoot: string;
  readonly runtimeRoot: string;
  readonly assetsRoot: string;
  readonly waifusRoot: string;
  readonly stageManagerDataRoot: string;
  readonly stateRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.defaultsRoot = path.join(this.workspaceRoot, "defaults");
    this.runtimeRoot = path.join(this.workspaceRoot, ".waifus");
    this.assetsRoot = path.join(this.runtimeRoot, "assets");
    this.waifusRoot = path.join(this.runtimeRoot, "waifus");
    this.stageManagerDataRoot = path.join(this.runtimeRoot, "stage-manager-data");
    this.stateRoot = path.join(this.runtimeRoot, "state");
  }

  defaultsConfigFile(): string {
    return path.join(this.defaultsRoot, "config.toml");
  }

  defaultsChannelsFile(): string {
    return path.join(this.defaultsRoot, "channels.toml");
  }

  defaultsOrchestratorFile(): string {
    return path.join(this.defaultsRoot, "orchestrator.toml");
  }

  defaultsStageManagerFile(): string {
    return path.join(this.defaultsRoot, "stage-manager.toml");
  }

  defaultsProviderCatalogFile(): string {
    return path.join(this.defaultsRoot, "providers.catalog.json");
  }

  defaultsWaifusRoot(): string {
    return path.join(this.defaultsRoot, "waifus");
  }

  defaultWaifuTemplateFile(): string {
    return path.join(this.defaultsWaifusRoot(), "default-waifu.json");
  }

  runtimeConfigFile(): string {
    return path.join(this.runtimeRoot, "config.toml");
  }

  runtimeProvidersFile(): string {
    return path.join(this.runtimeRoot, "providers.toml");
  }

  runtimeKeysFile(): string {
    return path.join(this.runtimeRoot, "keys.toml");
  }

  runtimeChannelsFile(): string {
    return path.join(this.runtimeRoot, "channels.toml");
  }

  runtimeOrchestratorFile(): string {
    return path.join(this.runtimeRoot, "orchestrator.toml");
  }

  runtimeStageManagerFile(): string {
    return path.join(this.runtimeRoot, "stage-manager.toml");
  }

  waifuFile(waifuId: string): string {
    return path.join(this.waifusRoot, `${waifuId}.json`);
  }

  stageManagerDataFile(waifuId: string): string {
    return path.join(this.stageManagerDataRoot, `${waifuId}.json`);
  }

  waifuAssetsDir(waifuId: string): string {
    return path.join(this.assetsRoot, "waifus", waifuId);
  }

  migrationStateFile(): string {
    return path.join(this.stateRoot, "migration-state.json");
  }

  migrationWarningsFile(): string {
    return path.join(this.stateRoot, "migration-warnings.json");
  }

  stageManagerCheckpointsFile(): string {
    return path.join(this.stateRoot, "stage-manager-checkpoints.json");
  }
}

export function createLocalConfigPaths(workspaceRoot: string): LocalConfigPaths {
  return new LocalConfigPaths(workspaceRoot);
}
