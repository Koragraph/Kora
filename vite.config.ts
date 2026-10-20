// @effect-diagnostics nodeBuiltinImport:off -- Vite config code (plain Node), not an Effect program.
import { defineConfig } from "vite-plus";
import "vite-plus/test/config";
import * as NodeURL from "node:url";

const fromRoot = (relative: string): string =>
  NodeURL.fileURLToPath(new URL(relative, import.meta.url));

// Trees that carry their own tooling (or vendored code) and stay out of every root-level tool.
const SEPARATE_TREES = ["packages/runtime/**", "koragent/**", "services/composio-broker/**"];
const BUILD_OUTPUT = ["dist", "dist-electron", "node_modules", "pnpm-lock.yaml", "*.tsbuildinfo"];

const TEST_TIMEOUT_MS = 60_000;
const GENERATED_ROUTES = "**/routeTree.gen.ts";

const testConfig = {
  setupFiles: [fromRoot("./packages/shared/src/testing/deepTempDir.ts")],
  testTimeout: TEST_TIMEOUT_MS,
  hookTimeout: TEST_TIMEOUT_MS,
  environment: "node" as const,
  exclude: [
    "**/.{idea,git,cache,output,temp}/**",
    "**/dist-electron/**",
    "**/dist/**",
    "**/node_modules/**",
    // Koragent runs under Bun; the broker is a standalone package run with `node --test`.
    "koragent/**",
    "services/composio-broker/**",
  ],
};

const switchedOff = (names: readonly string[]) =>
  Object.fromEntries(names.map((name) => [name, "off" as const]));

const OTHER_OFF_RULES = [
  "unicorn/no-array-sort",
  "unicorn/consistent-function-scoping",
  "oxc/no-map-spread",
  "react-in-jsx-scope",
  "react-hooks/exhaustive-deps",
  "eslint/no-shadow",
  "eslint/no-await-in-loop",
  "eslint/no-underscore-dangle",
];
const TYPESCRIPT_OFF_RULES = [
  "typescript/unbound-method",
  "typescript/restrict-template-expressions",
  "typescript/require-array-sort-compare",
  "typescript/await-thenable",
  "typescript/no-unsafe-type-assertion",
  "typescript/no-unnecessary-type-parameters",
  "typescript/no-unnecessary-type-assertion",
  "typescript/no-unnecessary-type-arguments",
  "typescript/no-unnecessary-type-conversion",
  "typescript/no-unnecessary-boolean-literal-compare",
  "typescript/no-redundant-type-constituents",
  "typescript/no-meaningless-void-operator",
  "typescript/no-implied-eval",
  "typescript/no-floating-promises",
  "typescript/no-duplicate-type-constituents",
  "typescript/no-base-to-string",
  "typescript/consistent-return",
];

export default defineConfig({
  test: testConfig,
  resolve: { alias: { "~": fromRoot("./apps/web/src") } },
  // Formatting only on commit: no lint or typecheck in the hook.
  staged: { "*": "vp fmt --no-error-on-unmatched-pattern" },
  fmt: {
    sortPackageJson: {},
    ignorePatterns: [...SEPARATE_TREES, ...BUILD_OUTPUT, GENERATED_ROUTES, "*.icon/**"],
  },
  lint: {
    jsPlugins: ["./packages/oxlint-plugin-kora/index.ts"],
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    ignorePatterns: [...SEPARATE_TREES, ...BUILD_OUTPUT, GENERATED_ROUTES],
    categories: {
      perf: "warn",
      suspicious: "warn",
      correctness: "warn",
    },
    rules: {
      ...switchedOff(OTHER_OFF_RULES),
      ...switchedOff(TYPESCRIPT_OFF_RULES),
      "eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@kora/client-runtime",
              message:
                "Import from an explicit @kora/client-runtime/* subpath. The package has no root export.",
            },
            {
              name: "@pierre/diffs/react",
              importNames: ["CodeView"],
              message:
                "Use StyledDiffCodeView so web diff surfaces share styling and virtualized geometry.",
            },
          ],
        },
      ],
      "kora/no-global-process-runtime": "error",
      "kora/no-inline-schema-compile": "warn",
      "kora/no-manual-effect-runtime-in-tests": "error",
      "kora/no-native-title-tooltip": "error",
      "kora/namespace-node-imports": "error",
    },
    overrides: [
      {
        files: ["packages/shared/src/hostMachine.ts"],
        rules: { "kora/no-global-process-runtime": "off" },
      },
      {
        // Plain-Node code outside the Effect/React app style.
        files: [
          "packages/ui-server/**",
          "qa/**",
          "spikes/**",
          "apps/desktop/scripts/**",
          // Launchers and build/CI scripts (kora-runtime.cjs, scripts/*-win.mjs, docs/research scripts).
          "apps/desktop/resources/**",
          "scripts/**",
          "docs/**",
          "packages/client-runtime/src/auth/identity.test.ts",
          "apps/desktop/src/backend/ShellKoraUiToken.test.ts",
        ],
        rules: {
          "kora/namespace-node-imports": "off",
          "kora/no-global-process-runtime": "off",
          "kora/no-manual-effect-runtime-in-tests": "off",
        },
      },
    ],
    options: {
      // Revisit once oxlint's type-aware path can integrate with the Effect diagnostics.
      typeCheck: false,
      typeAware: false,
      reportUnusedDisableDirectives: "error",
    },
  },
});
