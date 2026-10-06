/**
 * npm run dev — local service (tsx watch) + workbench Vite dev server against the real API.
 * Ctrl+C (or either process exiting) stops both.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const root = process.cwd();
const require = createRequire(join(root, "package.json"));
const dataDir = process.env.STUDY_STUDIO_DATA_DIR ?? join(root, "StudyStudioData");

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
    env: {
      STUDY_STUDIO_DATA_DIR: dataDir,
      STUDY_STUDIO_WORKBENCH_URL: process.env.STUDY_STUDIO_WORKBENCH_URL ?? "http://127.0.0.1:5173/app/"
    }
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

/** Once per `npm run dev` (not per tsx-watch restart): log in via the server's `.login-code` file and open the workbench. */
async function openWorkbenchOnce() {
  if (process.env.STUDY_STUDIO_NO_OPEN === "1") return;
  for (let i = 0; i < 60 && !stopping; i++) {
    const ok = await fetch("http://127.0.0.1:43118/health").then(
      (r) => r.ok,
      () => false
    );
    if (ok) {
      mkdirSync(dataDir, { recursive: true });
      const code = randomBytes(24).toString("base64url");
      writeFileSync(join(dataDir, ".login-code"), code, { mode: 0o600 });
      const url = `http://127.0.0.1:43118/app/login?code=${code}`;
      const [cmd, args] =
        process.platform === "darwin"
          ? ["open", [url]]
          : process.platform === "win32"
            ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]]
            : ["xdg-open", [url]];
      spawn(cmd, args, { stdio: "ignore", detached: true })
        .on("error", () => console.log(`[dev] 请手动打开 ${url}`))
        .unref();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
void openWorkbenchOnce();
