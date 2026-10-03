/** node:sqlite without a flag plus `allowExtension` (needed for sqlite-vec): 22.13+ on 22.x, 23.5+ on 23.x. */
export const MIN_NODE_VERSION = "22.13.0";

export function isSupportedNode(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  if (major > 23) return true;
  if (major === 23) return minor >= 5;
  if (major === 22) return minor >= 13;
  return false;
}

export function unsupportedNodeMessage(version: string): string {
  return [
    `Study Studio 需要 Node.js >= ${MIN_NODE_VERSION}（23.x 需 >= 23.5），当前为 ${version}。`,
    "原因：本地数据库使用 Node 内置的 node:sqlite 并加载 sqlite-vec 扩展。",
    "请升级 Node（推荐当前 LTS）：https://nodejs.org/ ，或使用 nvm：nvm install --lts"
  ].join("\n");
}
