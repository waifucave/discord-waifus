import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// dist/api/docsKb.js and src/api/docsKb.ts sit at the same depth from the package root,
// so two levels up reaches the root in both the built package and the tsx dev path.
const KB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "assistant-kb");

export type DocMeta = { slug: string; title: string; description: string };

function parseHeader(content: string): { title: string; description: string } {
  const lines = content.split("\n");
  const title = lines.find((line) => line.startsWith("# "))?.slice(2).trim() ?? "Untitled";
  const description = lines.find((line) => line.trim() && !line.startsWith("#"))?.trim() ?? "";
  return { title, description };
}

export async function listDocs(): Promise<DocMeta[]> {
  const files = (await readdir(KB_DIR)).filter((file) => file.endsWith(".md")).sort();
  return Promise.all(
    files.map(async (file) => {
      const content = await readFile(path.join(KB_DIR, file), "utf8");
      return { slug: file.replace(/\.md$/, ""), ...parseHeader(content) };
    })
  );
}

export async function readDoc(slug: string): Promise<{ slug: string; title: string; content: string } | undefined> {
  if (!/^[a-z0-9-]+$/.test(slug)) return undefined;
  try {
    const content = await readFile(path.join(KB_DIR, `${slug}.md`), "utf8");
    return { slug, title: parseHeader(content).title, content };
  } catch {
    return undefined;
  }
}

// Naive scoring: count query-term occurrences in the body, title hits weighted 5x.
export async function searchDocs(query: string): Promise<Array<DocMeta & { score: number }>> {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 2);
  const docs = await listDocs();
  const scored = await Promise.all(
    docs.map(async (doc) => {
      const content = (await readDoc(doc.slug))!.content.toLowerCase();
      const title = doc.title.toLowerCase();
      let score = 0;
      for (const term of terms) {
        score += content.split(term).length - 1 + (title.includes(term) ? 5 : 0);
      }
      return { ...doc, score };
    })
  );
  return scored.filter((doc) => doc.score > 0).sort((a, b) => b.score - a.score);
}
