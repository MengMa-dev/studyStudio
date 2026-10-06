# Study Studio skills 安装说明（供 AI Agent 执行）

用户要求安装 Study Studio 的 skills（如「安装 https://github.com/MengMa-dev/studyStudio 的 skills」）时，按以下步骤执行。

## 0. 征得确认（必须，未获明确同意不得执行后续步骤）

向用户发送并等待回复：

> 安装 Study Studio skills 需要同时安装并启动本地服务——skills 通过本地 MCP 读写知识库，不装服务无法生效。将执行：
>
> 1. 克隆 https://github.com/MengMa-dev/studyStudio 到 `~/study-studio`，安装依赖并构建（需 Node.js ≥ 22.13、git，约数分钟）；
> 2. 在后台启动服务（仅监听 `127.0.0.1:43118`，数据目录 `~/StudyStudioData`）；
> 3. 把 `organize-kb` skill 和 `study-studio` MCP 写入当前 agent 的配置。
>
> 是否继续？是否需要开机自启？

用户拒绝 → 停止，不做任何改动。

## 1. 检查环境

- `node -v`：需 ≥ 22.13（23.x 需 ≥ 23.5）；`git --version` 可用。不满足 → 告诉用户需要先安装，停止。
- `curl -sf http://127.0.0.1:43118/health` 成功 → 服务已在运行，若 `~/study-studio` 存在则跳到第 4 步。

## 2. 克隆并构建

```bash
if [ -d ~/study-studio ]; then git -C ~/study-studio pull --ff-only; else git clone --depth 1 https://github.com/MengMa-dev/studyStudio.git ~/study-studio; fi
cd ~/study-studio && npm install && npm run build
```

## 3. 启动服务

用户**不需要**开机自启（macOS / Linux）：

```bash
mkdir -p ~/StudyStudioData && cd ~/study-studio && nohup npm start -- --no-open > ~/StudyStudioData/server.log 2>&1 &
```

Windows（PowerShell）：`Start-Process -WindowStyle Hidden -WorkingDirectory ~/study-studio npm -ArgumentList "start","--","--no-open"`

用户**需要**开机自启：不执行上面的命令，改为 `cd ~/study-studio && npm start -- autostart enable`（Linux 再执行 `systemctl --user start study-studio`）。

然后每秒轮询 `curl -sf http://127.0.0.1:43118/health`，最多 30 秒；失败 → 把 `~/StudyStudioData/server.log` 最后几十行给用户，停止。

## 4. 安装 skill 与 MCP

按当前 agent 选择 `--target`（`cursor` / `claude` / `codex`，可重复）：

```bash
cd ~/study-studio && npm start -- agent install --target cursor
```

该命令写入 `organize-kb` skill，并注册 MCP（Cursor 合并 `~/.cursor/mcp.json`；Codex 合并 `~/.codex/config.toml`；Claude Code 调用 `claude mcp add`）。按输出提示处理失败项。

## 5. 告知用户

- 重新加载 agent 后生效（Cursor：重启或在 MCP 设置中刷新），之后说「整理收件箱」即可。
- 打开工作台：`cd ~/study-studio && npm start -- open`（每个浏览器只需登录一次）。
- 浏览器扩展（可选，用于采集）：安装后打开一次工作台即自动配对，无需填令牌。
- 停止服务：未开启自启时结束上面的 `npm start` 进程；开启自启的用 `npm start -- autostart disable` 关闭自启。
