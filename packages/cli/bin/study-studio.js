#!/usr/bin/env node
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isSupportedNode, unsupportedNodeMessage } from "../dist/server/node-version.js";

if (!isSupportedNode(process.versions.node)) {
  console.error(unsupportedNodeMessage(process.versions.node));
  process.exit(1);
}

// node:sqlite is still flagged experimental on some supported Node versions; hide only that warning.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
  if (type === "ExperimentalWarning" && String(warning).includes("SQLite")) return;
  emitWarning(warning, ...rest);
};

const { version } = createRequire(import.meta.url)("../package.json");
const { main } = await import("../dist/server/cli.js");
await main(process.argv.slice(2), { version, binPath: fileURLToPath(import.meta.url) });
