import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

export default defineConfig({
  root: here,
  plugins: [react()],
  build: {
    outDir: path.resolve(repoRoot, "dist-remote-shell"),
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022"
  }
});
