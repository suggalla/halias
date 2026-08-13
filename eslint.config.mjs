import js from "@eslint/js";
import ts from "typescript-eslint";

export default [
  { ignores: ["**/dist/**", "**/node_modules/**", "**/typechain-types/**",
              "**/.svelte-kit/**", "**/circuits/out/**", "lib/**", "out/**", "**/.e2e.cjs"] },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    languageOptions: { globals: { process: "readonly", console: "readonly", require: "readonly",
                            __dirname: "readonly", Buffer: "readonly" } },
    rules: {
      // Floating promises are the failure this codebase actually hits: a forgotten await on a
      // send or a refresh leaves the client reading state the chain has not reached.
      "no-void": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-require-imports": "off",
      "no-constant-condition": ["error", { checkLoops: false }],
      eqeqeq: ["error", "always"],
      "prefer-const": "error",
      "no-var": "error",
    },
  },
];
