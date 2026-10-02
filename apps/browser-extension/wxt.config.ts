import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: ".",
  entrypointsDir: "entrypoints",
  manifest: {
    name: "Study Studio Collector",
    description: "Local-first learning collection for supported AI conversations and web pages.",
    permissions: ["storage", "unlimitedStorage", "activeTab", "scripting", "tabs", "alarms", "webNavigation", "idle", "windows"],
    host_permissions: ["http://*/*", "https://*/*"]
  }
});
