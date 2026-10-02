import { join } from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const dev = process.env.STUDY_STUDIO_DEV === "1";
const common = {
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome120"],
  legalComments: "none",
  define: { __STUDY_STUDIO_DEV__: String(dev) }
};

await build({
  ...common,
  entryPoints: [join(root, "packages/collector-runtime/src/browser-collector.js")],
  outfile: join(root, "apps/browser-extension/runtime.js"),
  globalName: "StudyStudioCollector"
});
await build({
  ...common,
  entryPoints: [join(root, "apps/desktop/inject-entry.js")],
  outfile: join(root, "apps/desktop/dist/collector-inject.js")
});
console.log(
  `Built apps/browser-extension/runtime.js and apps/desktop/dist/collector-inject.js${dev ? " (DEV thresholds: capture after 5s, revisit counts from 3s)" : ""}`
);
