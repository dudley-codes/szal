import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import typescriptEslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: ["coverage/**", "dist/**", "node_modules/**"],
  },
  eslint.configs.recommended,
  typescriptEslint.configs.strictTypeChecked,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    extends: [typescriptEslint.configs.disableTypeChecked],
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },
);
