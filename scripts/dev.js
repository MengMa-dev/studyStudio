/**
 * npm run dev — local service (tsx watch) + workbench Vite dev server against the real API.
 * Ctrl+C (or either process exiting) stops both.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const root = process.cwd();
const require = createRequire(join(root, "package.json"));

function resolveBin(pkg, relative) {
  for (const base of [join(root, "node_modules"), join(root, "apps/workbench/node_modules")]) {
    const file = join(base, pkg, relative);
    if (existsSync(file)) return file;
  }
  return require.resolve(`${pkg}/${relative}`);
}

const tasks = [
  {
    name: "server",
    color: 36,
    args: [resolveBin("tsx", "dist/cli.mjs"), "watch", "services/local-ingestion/src/server.ts"],
    cwd: root,
    env: { STUDY_STUDIO_DATA_DIR: process.env.STUDY_STUDIO_DATA_DIR ?? join(root, "StudyStudioData") }
  },
  {
    name: "workbench",
    color: 35,
    args: [resolveBin("vite", "bin/vite.js")],
    cwd: join(root, "apps/workbench"),
    env: { VITE_MOCK: "0" }
  }
];

const children = new Map();
let stopping = false;
let exitCode = 0;

function prefixLines(name, color, stream, out) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) out.write(`\x1b[${color}m[${name}]\x1b[0m ${line}\n`);
  });
  stream.on("end", () => {
    if (buffer) out.write(`\x1b[${color}m[${name}]\x1b[0m ${buffer}\n`);
  });
}

function stopAll(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children.values()) child.kill(signal);
  setTimeout(() => {
    for (const child of children.values()) child.kill("SIGKILL");
  }, 5000).unref();
}

for (const task of tasks) {
  const child = spawn(process.execPath, task.args, {
    cwd: task.cwd,
    env: { ...process.env, ...task.env, FORCE_COLOR: process.env.FORCE_COLOR ?? "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.set(task.name, child);
  prefixLines(task.name, task.color, child.stdout, process.stdout);
  prefixLines(task.name, task.color, child.stderr, process.stderr);
  child.on("exit", (code, signal) => {
    children.delete(task.name);
    if (!stopping) {
      console.error(`[dev] ${task.name} exited (${signal ?? code}); stopping the rest.`);
      exitCode = code || 1;
      stopAll();
    }
    if (children.size === 0) process.exit(exitCode);
  });
}

process.on("SIGINT", () => stopAll("SIGINT"));
process.on("SIGTERM", () => stopAll("SIGTERM"));

console.log("[dev] 本地服务 http://127.0.0.1:43118 ；工作台（真实 API）http://127.0.0.1:5173/app/ ；Ctrl+C 退出");
