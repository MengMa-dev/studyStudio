import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "/app/",
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "src")
    }
  },
  server: {
    port: 5173,
    proxy: {
      "/v1": {
        target: "http://127.0.0.1:43118",
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: "dist",
    sourcemap: true
  }
});
