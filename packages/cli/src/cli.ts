import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFromEnv } from "@study-studio/local-ingestion";
import { CliUsageError, USAGE, parseCliArgs, type CliCommand } from "./args.js";
import { autostartStatus, disableAutostart, enableAutostart } from "./autostart.js";

export type MainContext = {
  version: string;
  /** Absolute path of the bin script that launched the CLI (used by autostart). */
  binPath: string;
};

/** In the published package this file is dist/server/*.js and the built workbench sits at dist/workbench. */
function bundledWorkbench(): string | undefined {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../workbench");
  return existsSync(join(dir, "index.html")) ? dir : undefined;
}

function checkPortFree(port: number): Promise<boolean> {
  if (port === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

export function openBrowser(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => console.log(`无法自动打开浏览器，请手动访问上面的 Workbench login 链接。`));
    child.unref();
  } catch {
    console.log(`无法自动打开浏览器，请手动访问上面的 Workbench login 链接。`);
  }
}

async function start(command: Extract<CliCommand, { kind: "start" }>): Promise<void> {
  if (!(await checkPortFree(command.port))) {
    console.error(`端口 ${command.port} 已被占用。若 Study Studio 已在运行，可直接访问 http://127.0.0.1:${command.port}/app/ ；否则用 --port 指定其他端口。`);
    process.exit(1);
  }
  const workbenchDist = bundledWorkbench();
  const started = await startFromEnv({
    dataDir: command.dataDir,
    port: command.port,
    ...(workbenchDist ? { workbenchDist } : {})
  });
  if (!started.vectorEnabled) {
    console.log("提示：sqlite-vec 扩展加载失败（当前平台可能没有预编译二进制），语义向量检索已关闭，全文检索与其他功能不受影响。");
  }
  if (command.open) openBrowser(started.loginUrl);
  console.log("按 Ctrl+C 停止服务。");
}

export async function main(argv: string[], context: MainContext): Promise<void> {
  let command: CliCommand;
  try {
    command = parseCliArgs(argv);
  } catch (error) {
    if (!(error instanceof CliUsageError)) throw error;
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }

  if (command.kind === "help") return void console.log(USAGE);
  if (command.kind === "version") return void console.log(context.version);
  if (command.kind === "start") return start(command);

  if (command.action === "status") return void console.log(autostartStatus());
  if (command.action === "disable") return void console.log(disableAutostart());
  const binPath = realpathSync(context.binPath);
  if (binPath.includes("_npx")) {
    console.warn("警告：当前通过 npx 临时缓存运行，缓存清理后自启会失效。建议先 npm i -g study-studio 再执行 study-studio autostart enable。");
  }
  console.log(enableAutostart({ nodePath: process.execPath, binPath, dataDir: command.dataDir, port: command.port }));
}
