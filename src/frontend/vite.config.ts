import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

export default defineConfig({
  root: here,
  plugins: [react()],
  build: {
    outDir: path.resolve(repoRoot, "dist-frontend"),
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022"
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3888",
        changeOrigin: true,
        ws: true
      }
    }
  }
});
