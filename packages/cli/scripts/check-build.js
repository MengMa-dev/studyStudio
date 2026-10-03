import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const required = ["dist/server/cli.js", "dist/server/node-version.js", "dist/migrations/001_init.sql", "dist/workbench/index.html"];
const missing = required.filter((file) => !existsSync(join(pkgDir, file)));

if (missing.length > 0) {
  console.error(`study-studio 包产物缺失：${missing.join(", ")}\n请先在仓库根目录运行 npm run build。`);
  process.exit(1);
}
