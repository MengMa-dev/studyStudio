import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

export const DEFAULT_PORT = 43118;

export type AutostartAction = "enable" | "disable" | "status";

export type CliCommand =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "start"; dataDir: string; port: number; open: boolean }
  | { kind: "autostart"; action: AutostartAction; dataDir: string; port: number };

export class CliUsageError extends Error {}

export const USAGE = `用法：study-studio [选项]
      study-studio autostart <enable|disable|status> [--data-dir <目录>] [--port <端口>]

启动 Study Studio 本地服务（127.0.0.1）并在浏览器中打开工作台。

选项：
  --data-dir <目录>  数据目录（默认 ~/StudyStudioData，或环境变量 STUDY_STUDIO_DATA_DIR）
  --port <端口>      监听端口（默认 ${DEFAULT_PORT}，或环境变量 STUDY_STUDIO_PORT；0 表示随机）
  --no-open          不自动打开浏览器
  -h, --help         显示帮助
  -v, --version      显示版本

autostart：登录系统后自动启动服务（macOS launchd / Linux systemd 用户服务 / Windows 计划任务），默认不开启。
建议先全局安装（npm i -g study-studio），避免 npx 缓存被清理后自启失效。`;

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new CliUsageError(`无效端口：${raw}（应为 0–65535 的整数）`);
  }
  return port;
}

export function defaultDataDir(home: string = homedir()): string {
  return join(home, "StudyStudioData");
}

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env, home: string = homedir()): CliCommand {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help) return { kind: "help" };
  if (values.version) return { kind: "version" };

  const dataDirRaw = values["data-dir"] ?? env.STUDY_STUDIO_DATA_DIR;
  const dataDir = dataDirRaw ? resolve(dataDirRaw.replace(/^~(?=$|[/\\])/, home)) : defaultDataDir(home);
  const portRaw = values.port ?? env.STUDY_STUDIO_PORT;
  const port = portRaw === undefined || portRaw === "" ? DEFAULT_PORT : parsePort(portRaw);

  const [command, action, ...rest] = positionals;
  if (command === undefined) return { kind: "start", dataDir, port, open: !values["no-open"] };
  if (command === "autostart") {
    if (action !== "enable" && action !== "disable" && action !== "status") {
      throw new CliUsageError("autostart 需要子命令：enable | disable | status");
    }
    if (rest.length > 0) throw new CliUsageError(`多余的参数：${rest.join(" ")}`);
    return { kind: "autostart", action, dataDir, port };
  }
  throw new CliUsageError(`未知命令：${command}`);
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      "data-dir": { type: "string" },
      port: { type: "string" },
      "no-open": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" }
    }
  });
}
