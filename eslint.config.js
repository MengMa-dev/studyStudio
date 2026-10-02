import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.output/**",
      "**/.wxt/**",
      "prototype/**",
      "StudyStudioData/**",
      "apps/browser-extension/runtime.js",
      "tests/fixtures/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }]
    }
  },
  {
    files: ["apps/browser-extension/*.js", "scripts/*.js"],
    languageOptions: { globals: { ...globals.webextensions } }
  },
  {
    files: ["packages/collector-runtime/**/*.js"],
    languageOptions: { globals: { __STUDY_STUDIO_DEV__: "readonly" } }
  }
);
