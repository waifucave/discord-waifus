// I17 (overhaul spec §10.6): the dashboard derives its API types from the shared zod schemas with
// type-only imports, so zod and the schemas never enter the browser bundle. A value import from
// src/shared/ is allowed only from the zod-free modules listed here.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const FRONTEND = path.join(process.cwd(), "src", "frontend");
/** Shared modules with no zod and no Node imports: safe at runtime in the browser. */
const RUNTIME_ALLOWED = [/\/shared\/constants\/[a-zA-Z]+$/u];

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (/\.(ts|tsx)$/u.test(entry.name)) out.push(full);
  }
  return out;
}

describe("frontend imports from src/shared", () => {
  it("are type-only, except zod-free constant modules", async () => {
    const offenders: string[] = [];
    let typeImports = 0;
    for (const file of await sourceFiles(FRONTEND)) {
      const text = await readFile(file, "utf8");
      const statements = text.match(/^(?:import|export)\b[^;]*?from\s+"[^"]*\/shared\/[^"]*";/gmsu) ?? [];
      for (const statement of statements) {
        const specifier = /from\s+"([^"]+)"/u.exec(statement)![1]!;
        if (/^(?:import|export)\s+type\b/u.test(statement)) {
          typeImports += 1;
          continue;
        }
        if (RUNTIME_ALLOWED.some((pattern) => pattern.test(specifier.replace(/\.js$/u, "")))) continue;
        offenders.push(`${path.relative(process.cwd(), file)}: ${statement.split("\n")[0]}`);
      }
      // Inline `import("…/shared/…")` types are fine; a dynamic value import is not.
      for (const match of text.matchAll(/await\s+import\(\s*"([^"]*\/shared\/[^"]*)"\s*\)/gu)) offenders.push(`${path.relative(process.cwd(), file)}: dynamic import ${match[1]}`);
    }
    expect(offenders).toEqual([]);
    expect(typeImports).toBeGreaterThan(0);
  });

  it("the allowed constant modules import nothing", async () => {
    const dir = path.join(process.cwd(), "src", "shared", "constants");
    for (const file of await readdir(dir)) {
      const text = await readFile(path.join(dir, file), "utf8");
      expect(text, file).not.toMatch(/^import\s/mu);
    }
  });
});
