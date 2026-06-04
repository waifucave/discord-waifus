import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "smol-toml";
import { z } from "zod";
import { DEFAULT_APP_CONFIG } from "../shared/schemas/config.js";
import { CURRENT_SCHEMA_VERSION, createRevisionedBase } from "../shared/schemas/common.js";
import { WaifuConfigSchema } from "../shared/schemas/domain.js";
import { resolveDataPath } from "./paths.js";
import { PREBUILT_WAIFUS } from "./prebuiltWaifus.js";

export const DATA_LAYOUT_DIRS = [
  "app",
  "app/logs",
  "app/cache",
  "app/cache/ocr",
  "app/cache/ocr/bin",
  "app/cache/ocr/results",
  "app/tmp",
  "app/tmp/ocr",
  "app/tmp/swift-module-cache",
  "user",
  "user/waifus",
  "user/orchestrator",
  "user/stage-manager",
  "user/reviewer",
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

const PrebuiltWaifuSeedMarkerSchema = z.object({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
  seededAt: z.string().datetime({ offset: true }),
  waifuIds: z.array(z.string())
});

export async function ensureDataLayout(dataRoot: string): Promise<void> {
  await mkdir(dataRoot, { recursive: true });
  await Promise.all(DATA_LAYOUT_DIRS.map((dir) => mkdir(resolveDataPath(dataRoot, dir), { recursive: true })));

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
    await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, { mode: 0o600 });
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
