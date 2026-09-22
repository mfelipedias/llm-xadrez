import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const backend = process.env.VITE_BACKEND ?? "http://localhost:3939";

export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": path.resolve(here, "../shared"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": backend,
      "/mcp": backend,
      "/ws": { target: backend, ws: true },
    },
  },
  build: {
    outDir: path.resolve(here, "dist"),
    emptyOutDir: true,
  },
});
