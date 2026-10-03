import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const LAUNCHD_LABEL = "com.studystudio.server";
export const SYSTEMD_UNIT = "study-studio.service";
export const WINDOWS_TASK = "StudyStudio";

export type AutostartTarget = {
  /** Absolute path of the node binary. */
  nodePath: string;
  /** Absolute path of bin/study-studio.js. */
  binPath: string;
  dataDir: string;
  port: number;
};

export function serverArgs(target: AutostartTarget): string[] {
  return [target.binPath, "--no-open", "--data-dir", target.dataDir, "--port", String(target.port)];
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function launchdPlist(target: AutostartTarget): string {
  const args = [target.nodePath, ...serverArgs(target)].map((arg) => `    <string>${xmlEscape(arg)}</string>`).join("\n");
  const log = xmlEscape(join(target.dataDir, "logs", "server.log"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}

function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function systemdUnit(target: AutostartTarget): string {
  const exec = [target.nodePath, ...serverArgs(target)].map(systemdQuote).join(" ");
  return `[Unit]
Description=Study Studio local service

[Service]
ExecStart=${exec}
Restart=on-failure

[Install]
WantedBy=default.target
`;
}

export function windowsTaskCommand(target: AutostartTarget): string {
  return [target.nodePath, ...serverArgs(target)].map((arg) => `"${arg}"`).join(" ");
}

export function autostartFile(platform: NodeJS.Platform, home: string = homedir()): string | null {
  if (platform === "darwin") return join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  if (platform === "linux") return join(home, ".config", "systemd", "user", SYSTEMD_UNIT);
  return null;
}

function run(cmd: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

export function enableAutostart(target: AutostartTarget, platform: NodeJS.Platform = process.platform): string {
  const file = autostartFile(platform);
  if (platform === "darwin" && file) {
    mkdirSync(dirname(file), { recursive: true });
    mkdirSync(join(target.dataDir, "logs"), { recursive: true });
    run("launchctl", ["unload", file]);
    writeFileSync(file, launchdPlist(target));
    const loaded = run("launchctl", ["load", "-w", file]);
    if (!loaded.ok) throw new Error(`launchctl load 失败：${loaded.output}`);
    return `已开启开机自启（launchd：${file}）`;
  }
  if (platform === "linux" && file) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, systemdUnit(target));
    run("systemctl", ["--user", "daemon-reload"]);
    const enabled = run("systemctl", ["--user", "enable", SYSTEMD_UNIT]);
    if (!enabled.ok) throw new Error(`systemctl --user enable 失败：${enabled.output}`);
    return `已开启开机自启（systemd 用户服务：${file}，下次登录生效；立即启动：systemctl --user start ${SYSTEMD_UNIT}）`;
  }
  if (platform === "win32") {
    const created = run("schtasks", ["/Create", "/TN", WINDOWS_TASK, "/SC", "ONLOGON", "/TR", windowsTaskCommand(target), "/F"]);
    if (!created.ok) throw new Error(`schtasks /Create 失败：${created.output}`);
    return `已开启开机自启（计划任务：${WINDOWS_TASK}）`;
  }
  throw new Error(`当前平台不支持开机自启：${platform}`);
}

export function disableAutostart(platform: NodeJS.Platform = process.platform): string {
  const file = autostartFile(platform);
  if (platform === "darwin" && file) {
    if (existsSync(file)) run("launchctl", ["unload", "-w", file]);
    rmSync(file, { force: true });
    return "已关闭开机自启";
  }
  if (platform === "linux" && file) {
    run("systemctl", ["--user", "disable", SYSTEMD_UNIT]);
    rmSync(file, { force: true });
    run("systemctl", ["--user", "daemon-reload"]);
    return "已关闭开机自启";
  }
  if (platform === "win32") {
    run("schtasks", ["/Delete", "/TN", WINDOWS_TASK, "/F"]);
    return "已关闭开机自启";
  }
  throw new Error(`当前平台不支持开机自启：${platform}`);
}

export function autostartStatus(platform: NodeJS.Platform = process.platform): string {
  const file = autostartFile(platform);
  if (file) return existsSync(file) ? `开机自启：已开启（${file}）` : "开机自启：未开启";
  if (platform === "win32") return run("schtasks", ["/Query", "/TN", WINDOWS_TASK]).ok ? "开机自启：已开启" : "开机自启：未开启";
  return `当前平台不支持开机自启：${platform}`;
}
