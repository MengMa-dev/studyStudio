/**
 * npm run build          shared (typecheck; consumed as TS source) → workbench → study-studio package (tsup)
 * npm run build:release  + extension `wxt zip` + `npm pack` of the study-studio package, collected in release/
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const release = process.argv.includes("--release");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function step(title, cmd, args, cwd = root) {
  console.log(`\n▶ ${title}`);
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) {
    console.error(`✖ ${title} failed`);
    process.exit(result.status ?? 1);
  }
}

step("shared: typecheck", process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", "packages/shared"]);
step("workbench: vite build", npm, ["run", "build", "-w", "@study-studio/workbench"]);
step("study-studio: tsup bundle", npm, ["run", "build", "-w", "study-studio"]);

if (release) {
  const outDir = join(root, "release");
  mkdirSync(outDir, { recursive: true });
  step("extension: wxt zip", npm, ["run", "zip", "-w", "@study-studio/browser-extension"]);
  const extensionOut = join(root, "apps/browser-extension/.output");
  for (const file of readdirSync(extensionOut).filter((name) => name.endsWith(".zip"))) {
    copyFileSync(join(extensionOut, file), join(outDir, file));
  }
  step("study-studio: npm pack", npm, ["pack", "-w", "study-studio", "--pack-destination", outDir]);
  console.log(`\n✔ Release artifacts in ${outDir}:\n  ${readdirSync(outDir).join("\n  ")}`);
} else {
  console.log("\n✔ Build complete. Run `npm start` (or `node packages/cli/bin/study-studio.js`) to start the packaged server.");
}
