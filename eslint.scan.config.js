// Strict ESLint config that mirrors the Obsidian Community Plugin Store scan.
// Run with: npx eslint --config eslint.scan.config.js src
//
// We expand obsidianmd/recommended via tseslint.config() so that nested
// `extends: [tseslint.configs.recommendedTypeChecked]` entries are flattened
// (flat-config requires that helper to process `extends`).

import tseslint from "typescript-eslint";
import obsidianPlugin from "eslint-plugin-obsidianmd";

export default tseslint.config(
  ...obsidianPlugin.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname
      },
      globals: {
        // Obsidian globals declared in obsidian.d.ts but invisible to ESLint
        activeWindow: "readonly",
        activeDocument: "readonly",
        createFragment: "readonly",
        // Standard DOM globals — TypeScript handles undefined refs, so we don't
        // need ESLint's no-undef to second-guess them.
        window: "readonly",
        document: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        Image: "readonly",
        getComputedStyle: "readonly"
      }
    },
    rules: {
      // TypeScript already verifies undefined identifiers — no-undef just
      // duplicates the check while missing TS-declared globals.
      "no-undef": "off",
      // Mirror the brand/acronym list from eslint.config.js so this scan
      // config produces the same sentence-case verdict as the local lint.
      // The live Obsidian Community Plugin Store scan accepts these brand
      // names (verified empirically — no sentence-case findings on the
      // plugin's directory page even though the recommended preset alone
      // would flag them).
      "obsidianmd/ui/sentence-case": ["error", {
        enforceCamelCaseLower: true,
        brands: [
          "iOS", "iPadOS", "macOS", "Windows", "Android", "Linux",
          "Obsidian", "Obsidian Sync", "Obsidian Publish",
          "WordPress", "LinkedIn", "Substack", "Postman", "Polylang",
          "NotebookLM", "Google", "OpenID Connect", "OAuth"
        ],
        acronyms: [
          "API", "HTTP", "HTTPS", "URL", "JSON", "XML", "HTML", "CSS",
          "SEO", "ID", "UUID", "MCP", "WP", "FR", "EN"
        ],
        ignoreWords: ["IDs", "GET", "English", "French"]
      }]
    }
  },
  {
    ignores: [
      "main.js",
      "node_modules/",
      "dist/",
      "build/",
      "*.js.map",
      "coverage/",
      "tests/**",
      "test-files/**",
      "deployment/**",
      "esbuild.config.mjs",
      "version-bump.mjs",
      "vitest.config.ts"
    ]
  }
);
