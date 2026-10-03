import { spawn } from "node:child_process";

export type RevealLauncher = (path: string) => void;

function systemOpener(): string {
  if (process.platform === "darwin") return "open";
  if (process.platform === "win32") return "explorer";
  return "xdg-open";
}

const defaultLauncher: RevealLauncher = (path) => {
  const child = spawn(systemOpener(), [path], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
};

let launcher: RevealLauncher = defaultLauncher;

/** Tests replace the file-manager launcher; returns a restore function. */
export function setRevealLauncher(next: RevealLauncher): () => void {
  const previous = launcher;
  launcher = next;
  return () => {
    launcher = previous;
  };
}

export function revealPath(path: string): void {
  launcher(path);
}
