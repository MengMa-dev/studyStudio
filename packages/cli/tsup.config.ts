import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

const pkgDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(pkgDir, "../..");
const migrationsSrc = join(repoRoot, "services/local-ingestion/src/migrations");
const workbenchSrc = join(repoRoot, "apps/workbench/dist");

/**
 * Layout under dist/ mirrors what the bundled server code resolves at runtime:
 * - server/*.js        bundle; db code reads `../migrations` relative to its own file
 * - migrations/*.sql
 * - workbench/         built apps/workbench (served at /app)
 */
export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    "node-version": "src/node-version.ts"
  },
  outDir: "dist/server",
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  splitting: true,
  sourcemap: false,
  dts: false,
  // `node:sqlite` only exists with the prefix.
  removeNodeProtocol: false,
  // sqlite-vec ships a platform-specific loadable binary via optionalDependencies; keep it a real dependency.
  noExternal: [/^(?!sqlite-vec(\/|$))/],
  external: ["sqlite-vec"],
  banner: {
    js: "import { createRequire as __ssCreateRequire } from 'node:module'; const require = __ssCreateRequire(import.meta.url);"
  },
  async onSuccess() {
    if (!existsSync(workbenchSrc)) {
      throw new Error("apps/workbench/dist not found; run `npm run build -w @study-studio/workbench` first (or `npm run build` at repo root).");
    }
    const migrationsOut = join(pkgDir, "dist/migrations");
    const workbenchOut = join(pkgDir, "dist/workbench");
    rmSync(migrationsOut, { recursive: true, force: true });
    rmSync(workbenchOut, { recursive: true, force: true });
    cpSync(migrationsSrc, migrationsOut, { recursive: true, filter: (src) => !src.endsWith(".DS_Store") });
    cpSync(workbenchSrc, workbenchOut, { recursive: true, filter: (src) => !src.endsWith(".map") && !src.endsWith(".DS_Store") });
  }
});
