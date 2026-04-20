import { promises as fs } from "node:fs";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import { z, type ZodTypeAny } from "zod";

export async function readTomlFile<TSchema extends ZodTypeAny>(
  filePath: string,
  schema: TSchema,
  options: {
    decode?: (value: unknown) => unknown;
    missingValue?: z.output<TSchema>;
  } = {}
): Promise<z.output<TSchema>> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = parse(raw);
    const normalized = options.decode ? options.decode(parsed) : parsed;
    return schema.parse(normalized);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" && options.missingValue !== undefined) {
      return schema.parse(options.missingValue);
    }
    throw error;
  }
}

export async function writeTomlFile<T>(
  filePath: string,
  value: T,
  options: {
    encode?: (value: T) => unknown;
  } = {}
): Promise<void> {
  const encoded = options.encode ? options.encode(value) : value;
  const text = `${stringify(encoded as Record<string, unknown>)}\n`;
  await atomicWriteFile(filePath, text);
}

export async function readJsonFile<TSchema extends ZodTypeAny>(
  filePath: string,
  schema: TSchema,
  options: { missingValue?: z.output<TSchema> } = {}
): Promise<z.output<TSchema>> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return schema.parse(JSON.parse(raw));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" && options.missingValue !== undefined) {
      return schema.parse(options.missingValue);
    }
    throw error;
  }
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function atomicWriteFile(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, contents, "utf8");
  await fs.rename(tempPath, filePath);
}
