import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "Study Studio Collector",
    description: "Local-first learning collection for supported AI conversations and web pages.",
    permissions: ["storage", "activeTab", "scripting", "tabs"],
    host_permissions: ["http://*/*", "https://*/*"]
  },
  vite: () => ({
    define: { __STUDY_STUDIO_DEV__: JSON.stringify(process.env.STUDY_STUDIO_DEV === "1") }
  })
});
