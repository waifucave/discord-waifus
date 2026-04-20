import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const cliConfigSchema = z.object({
  defaultProjectRoot: z.string().min(1).nullable().default(null)
});

export type CliConfig = z.infer<typeof cliConfigSchema>;

export function getCliConfigPath(): string {
  const configHome = process.env.WAIFUS_CONFIG_HOME?.trim();
  if (configHome) {
    return path.resolve(configHome, "config.json");
  }

  return path.join(os.homedir(), ".config", "waifus", "config.json");
}

export async function loadCliConfig(): Promise<CliConfig> {
  const filePath = getCliConfigPath();

  try {
    const raw = await fs.readFile(filePath, "utf8");
    return cliConfigSchema.parse(JSON.parse(raw));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return cliConfigSchema.parse({});
    }
    throw error;
  }
}

export async function saveCliConfig(nextConfig: CliConfig): Promise<void> {
  const filePath = getCliConfigPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(cliConfigSchema.parse(nextConfig), null, 2)}\n`, "utf8");
}
