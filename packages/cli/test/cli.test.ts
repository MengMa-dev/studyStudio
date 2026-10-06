import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { mergeCodexMcp, mergeCursorMcp } from "@study-studio/local-ingestion";
import { CliUsageError, DEFAULT_PORT, parseCliArgs } from "../src/args.js";
import { autostartFile, launchdPlist, systemdUnit, windowsTaskCommand } from "../src/autostart.js";
import { isSupportedNode } from "../src/node-version.js";

const home = "/home/tester";

test("parseCliArgs: defaults to ~/StudyStudioData, port 43118, open browser", () => {
  assert.deepEqual(parseCliArgs([], {}, home), { kind: "start", dataDir: join(home, "StudyStudioData"), port: DEFAULT_PORT, open: true });
});

test("parseCliArgs: flags override env, env overrides defaults", () => {
  const env = { STUDY_STUDIO_DATA_DIR: "/env/data", STUDY_STUDIO_PORT: "5000" };
  assert.deepEqual(parseCliArgs([], env, home), { kind: "start", dataDir: "/env/data", port: 5000, open: true });
  assert.deepEqual(parseCliArgs(["--data-dir", "~/x", "--port", "0", "--no-open"], env, home), {
    kind: "start",
    dataDir: join(home, "x"),
    port: 0,
    open: false
  });
  assert.equal((parseCliArgs(["--data-dir=rel"], {}, home) as { dataDir: string }).dataDir, resolve("rel"));
});

test("parseCliArgs: help / version / autostart", () => {
  assert.deepEqual(parseCliArgs(["--help"], {}, home), { kind: "help" });
  assert.deepEqual(parseCliArgs(["-v"], {}, home), { kind: "version" });
  assert.deepEqual(parseCliArgs(["autostart", "status", "--port", "43119"], {}, home), {
    kind: "autostart",
    action: "status",
    dataDir: join(home, "StudyStudioData"),
    port: 43119
  });
});

test("parseCliArgs: open / agent install", () => {
  const dataDir = join(home, "StudyStudioData");
  assert.deepEqual(parseCliArgs(["open"], {}, home), { kind: "open", dataDir, port: DEFAULT_PORT });
  assert.deepEqual(parseCliArgs(["agent", "install"], {}, home), { kind: "agent-install", dataDir, port: DEFAULT_PORT, targets: ["cursor"] });
  assert.deepEqual((parseCliArgs(["agent", "install", "--target", "claude", "--target", "codex"], {}, home) as { targets: string[] }).targets, [
    "claude",
    "codex"
  ]);
});

test("MCP config merge keeps other servers and replaces ours", () => {
  const endpoint = { url: "http://127.0.0.1:43118/mcp", token: "T" };
  const cursor = JSON.parse(mergeCursorMcp(mergeCursorMcp('{"mcpServers":{"other":{"url":"x"}}}', { ...endpoint, token: "old" }), endpoint));
  assert.deepEqual(cursor.mcpServers.other, { url: "x" });
  assert.equal(cursor.mcpServers["study-studio"].headers.Authorization, "Bearer T");
  assert.equal(JSON.parse(mergeCursorMcp("", endpoint)).mcpServers["study-studio"].url, endpoint.url);
  assert.throws(() => mergeCursorMcp("not json", endpoint));

  const toml = mergeCodexMcp('model = "o3"\n\n[mcp_servers.study-studio]\nurl = "old"\n\n[mcp_servers.other]\nurl = "x"\n', endpoint);
  assert.equal(toml.match(/\[mcp_servers\.study-studio\]/g)?.length, 1);
  assert.match(toml, /\[mcp_servers\.other\]\nurl = "x"/);
  assert.match(toml, /^model = "o3"/);
  assert.doesNotMatch(toml, /"old"/);
  assert.match(toml, /Authorization = "Bearer T"/);
});

test("parseCliArgs: rejects bad input", () => {
  for (const argv of [
    ["--port", "abc"],
    ["--port", "70000"],
    ["--port", "-1"],
    ["--unknown"],
    ["serve"],
    ["autostart"],
    ["autostart", "on"],
    ["agent"],
    ["agent", "install", "--target", "vim"],
    ["open", "x"]
  ]) {
    assert.throws(() => parseCliArgs(argv, {}, home), CliUsageError, argv.join(" "));
  }
});

test("isSupportedNode: node:sqlite + allowExtension floor", () => {
  for (const ok of ["22.13.0", "v22.22.1", "23.5.0", "24.0.0", "26.1.0"]) assert.equal(isSupportedNode(ok), true, ok);
  for (const bad of ["20.18.0", "22.12.9", "22.5.0", "23.4.0", "18.0.0"]) assert.equal(isSupportedNode(bad), false, bad);
});

test("autostart: generated configs run the bin with --no-open and the chosen data dir/port", () => {
  const target = { nodePath: "/usr/bin/node", binPath: "/opt/ss/bin/study-studio.js", dataDir: "/data/A&B", port: 43118 };
  const plist = launchdPlist(target);
  assert.match(plist, /<string>\/opt\/ss\/bin\/study-studio\.js<\/string>/);
  assert.match(plist, /<string>--no-open<\/string>/);
  assert.match(plist, /<string>\/data\/A&amp;B<\/string>/);
  assert.match(
    systemdUnit(target),
    /^ExecStart="\/usr\/bin\/node" "\/opt\/ss\/bin\/study-studio\.js" "--no-open" "--data-dir" "\/data\/A&B" "--port" "43118"$/m
  );
  assert.equal(windowsTaskCommand(target), '"/usr/bin/node" "/opt/ss/bin/study-studio.js" "--no-open" "--data-dir" "/data/A&B" "--port" "43118"');
  assert.equal(autostartFile("darwin", home), join(home, "Library/LaunchAgents/com.studystudio.server.plist"));
  assert.equal(autostartFile("linux", home), join(home, ".config/systemd/user/study-studio.service"));
  assert.equal(autostartFile("win32", home), null);
});
