export default [
  { ignores: ["dist/**", "node_modules/**"] },
  {
    files: ["src/**/*.{js,jsx,mjs}", "vite.config.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: Object.fromEntries(
        [
          "window",
          "document",
          "localStorage",
          "URL",
          "Node",
          "crypto",
          "structuredClone",
          "setTimeout",
          "clearTimeout",
        ].map((name) => [name, "readonly"]),
      ),
    },
    rules: {
      "no-undef": "error",
      "no-unreachable": "error",
      "no-dupe-keys": "error",
      "no-constant-condition": "error",
      "no-unexpected-multiline": "error",
    },
  },
];
