import eslintConfigPrettier from "eslint-config-prettier";
import stylistic from "@stylistic/eslint-plugin";
import tseslint from "typescript-eslint";

// Canonical backend lint path: ESLint + typescript-eslint + @stylistic + Prettier.
// (Migrated from Oxlint: Oxlint cannot enforce the semantic padding and import
// boundary rules this repository requires. See HANDOFF history.)
//
// PayLens import invariant: @/* maps to this app's src/*.
// Same physical folder → ./relative (with ESM .js suffix).
// Crossing a directory boundary → @/ (with ESM .js suffix).
// Parent-directory (../) and child-directory (.//*/) source imports are forbidden.
const importBoundaryRules = {
  "no-restricted-imports": [
    "error",
    {
      patterns: [
        {
          group: ["../**"],
          message:
            "Parent-directory imports are forbidden. Use @/ (this app's src/) for cross-directory imports.",
        },
        {
          group: ["./*/*", "./*/*/*", "./*/*/*/*", "./*/*/*/*/*"],
          message:
            "Child-directory relative imports are forbidden. Same-folder files use ./, everything else uses @/.",
        },
      ],
    },
  ],
};

// Semantic spacing: Prettier owns structural formatting; these rules own
// mechanically enforceable blank-line grouping (imports/types/setup/return).
// Adjacent-group "any" entries come last: when several entries match a pair,
// the last matching entry wins, so logical groups stay together.
const readabilityRules = {
  "@stylistic/padding-line-between-statements": [
    "error",
    { blankLine: "always", prev: "import", next: "*" },
    { blankLine: "always", prev: "export", next: "*" },
    { blankLine: "any", prev: ["type", "interface"], next: ["type", "interface"] },
    { blankLine: "always", prev: ["type", "interface"], next: "*" },
    {
      blankLine: "any",
      prev: ["const", "let", "var", "using"],
      next: ["const", "let", "var", "using"],
    },
    { blankLine: "always", prev: ["const", "let", "var", "using"], next: "*" },
    { blankLine: "always", prev: "directive", next: "*" },
    { blankLine: "always", prev: "multiline-block-like", next: "*" },
    { blankLine: "always", prev: "*", next: "return" },
    { blankLine: "any", prev: "import", next: "import" },
    {
      blankLine: "any",
      prev: ["const", "let", "var", "using"],
      next: ["const", "let", "var", "using"],
    },
  ],
};

export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**", "prisma/generated/**"],
  },
  ...tseslint.configs.recommended,
  {
    plugins: {
      "@stylistic": stylistic,
    },
    rules: {
      eqeqeq: "error",
      "no-console": "error",
      ...importBoundaryRules,
      ...readabilityRules,
    },
  },
  // Must be last: disables ESLint formatting rules that would fight Prettier.
  eslintConfigPrettier,
);
