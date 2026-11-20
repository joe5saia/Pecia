import cloudflare from "@cloudflare/oxlint-config";
import { defineConfig } from "oxlint";

// Cloudflare's shared preset (@cloudflare/oxlint-config, which builds on
// @nkzw/oxlint-config), then this repository's own rules: the Effect style
// (AGENTS.md, "Effect style") and the categories pecia ran before the preset.
export default defineConfig({
  ...cloudflare,
  jsPlugins: [...(cloudflare.jsPlugins ?? []), "./packages/lint-rules/src/index.ts"],
  categories: {
    correctness: "error",
    suspicious: "warn",
  },
  ignorePatterns: [...(cloudflare.ignorePatterns ?? []), "**/.alchemy/**", "e2e/fixtures/**"],
  rules: {
    ...cloudflare.rules,

    "vitest/no-standalone-expect": [
      "error",
      {
        additionalTestBlockFunctions: ["it.effect", "it.scoped", "it.live", "it.layer"],
      },
    ],
    "no-underscore-dangle": ["warn", { allow: ["_tag"] }],

    "pecia/no-tacit": "error",
    "pecia/prefer-data-first": "error",
    "pecia/prefer-fn": "error",
    "pecia/prefer-for-each": "error",
    "pecia/match-unions": "error",
    "pecia/run-at-the-edge": "error",
    "no-nested-ternary": "error",
    "no-restricted-imports": [
      "error",
      {
        paths: [
          {
            name: "effect",
            importNames: ["flow"],
            message: "Write the function out, as in `(x) => g(f(x))`, or use `.pipe`.",
          },
          {
            name: "effect/Function",
            importNames: ["flow"],
            message: "Write the function out, as in `(x) => g(f(x))`, or use `.pipe`.",
          },
        ],
      },
    ],
    "no-restricted-properties": [
      "error",
      { object: "process", property: "stdout", message: "Write through `Stdio` from effect." },
      { object: "process", property: "stderr", message: "Write through `Stdio` from effect." },
      { object: "process", property: "stdin", message: "Read through `Stdio` from effect." },
      { object: "process", property: "argv", message: "Read the arguments through `Stdio` from effect." },
      {
        object: "process",
        property: "exitCode",
        message: "Fail with an error that has `[Runtime.errorExitCode]`; `runMain` exits with it.",
      },
      {
        object: "process",
        property: "exit",
        message: "Fail with an error that has `[Runtime.errorExitCode]`; `runMain` exits with it.",
      },
    ],
    "typescript/consistent-type-assertions": ["error", { assertionStyle: "never" }],

    // Where the preset meets the Effect style. Each rule below is off or
    // configured on purpose; the reason is beside it.
    //
    // Effect's modules are imported as namespaces (`import * as Effect from "effect/Effect"`).
    "import/no-namespace": "off",
    // A foreign exception is classified by its class where it enters (AGENTS.md, "Errors").
    "@nkzw/no-instanceof": "off",
    // Callbacks are written out (AGENTS.md, "Effect style"), never passed as `Boolean` or `String`.
    "unicorn/prefer-native-coercion-functions": "off",
    // `{}` is how Effect spells a case or error with no fields: `Data.TaggedError("X")<{}>`.
    "typescript/no-empty-object-type": ["error", { allowObjectTypes: "always" }],
    // Optional fields are left out with a conditional spread: `exactOptionalPropertyTypes`
    // refuses `undefined`, and the code builds values without mutating them.
    "quality/no-conditional-empty-object-spread": "off",
    // A lookup table indexed by any string is typed `Record<string, A>` on purpose, so a
    // missing key reads `undefined` (`noUncheckedIndexedAccess`).
    "quality/no-known-value-widening": "off",

    // The preset adds the react, jsx-a11y and promise plugins without their categories;
    // the categories above turn these on with them. They are off because:
    // the viewer uses React's automatic JSX runtime;
    "react/react-in-jsx-scope": "off",
    // they read `Effect.catch(effect, f)` as a `Promise.catch` with two arguments.
    "promise/valid-params": "off",
  },
  overrides: [
    ...(cloudflare.overrides ?? []),
    {
      files: ["e2e/**"],
      rules: {
        "pecia/run-at-the-edge": "off",
      },
    },
    {
      // The fakes and the harness pass the wire's data through as it came; the product
      // decodes it with a Schema.
      files: ["e2e/**"],
      rules: {
        "quality/no-unknown-returns": "off",
      },
    },
    {
      // The rule asks for `<hr>` for the comments resizer, a focusable splitter with a value that
      // `<hr>` cannot be, and `<output>` for the editor's live status lines, which are not results.
      files: ["packages/viewer/src/App.tsx", "packages/viewer/src/Editor.tsx"],
      rules: {
        "jsx-a11y/prefer-tag-over-role": "off",
      },
    },
    {
      // The new page's path field is focused when the person clicks "New page", which shows it.
      files: ["packages/viewer/src/App.tsx"],
      rules: {
        "jsx-a11y/no-autofocus": "off",
      },
    },
  ],
});
