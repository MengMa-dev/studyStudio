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
    // `npm run dev` sends the login redirect here; drifting to another port would land on a dead URL.
    strictPort: true,
    proxy: {
      "/v1": {
        target: "http://127.0.0.1:43118",
        changeOrigin: true,
        // The service only accepts same-origin writes; present proxied requests as coming from it.
        headers: { origin: "http://127.0.0.1:43118" }
      }
    }
  },
  build: {
    outDir: "dist",
    sourcemap: true
  }
});
