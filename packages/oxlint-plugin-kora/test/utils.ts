// @effect-diagnostics nodeBuiltinImport:off - runs the real oxlint binary over fixture files on disk
// @effect-diagnostics preferSchemaOverJson:off - writes a plain JSON config file
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

// oxlint comes in through vite-plus, and where its bin ends up depends on the package manager: find the package
// from vite-plus's own location. Doing it here makes a broken install fail once, plainly.
const OXLINT_BIN = NodePath.join(
  NodePath.dirname(
    NodeModule.createRequire(
      NodeModule.createRequire(import.meta.url).resolve("vite-plus/package.json"),
    ).resolve("oxlint/package.json"),
  ),
  "bin",
  "oxlint",
);
const PLUGIN = NodePath.join(import.meta.dirname, "..", "index.ts");
const REPO = NodePath.join(import.meta.dirname, "..", "..", "..");

type Options = {
  /** The fixture's file name (the extension decides the parser; some rules look at the name). */
  filename?: string;
  /** What follows the severity in the lint config for this rule. */
  options?: ReadonlyArray<unknown>;
};

/** Lints `code` with only `rule` turned on. */
export function lint(
  rule: string,
  code: string,
  { filename = "fixture.ts", options = [] }: Options = {},
) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-lint-"));
  try {
    const config = NodePath.join(dir, ".oxlintrc.json");
    NodeFS.writeFileSync(
      config,
      JSON.stringify({
        jsPlugins: [{ name: "kora", specifier: PLUGIN }],
        rules: { [rule]: ["error", ...options] },
      }),
    );
    const file = NodePath.join(dir, filename);
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, code);
    // Through this Node: the bin is an extensionless script (Windows cannot spawn it, and PATH may hold another node).
    const run = NodeChildProcess.spawnSync(
      process.execPath,
      [OXLINT_BIN, "--config", config, file],
      {
        cwd: REPO,
        encoding: "utf8",
      },
    );
    return { reported: run.status !== 0, output: `${run.stdout}${run.stderr}` };
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Cases for one rule. `allows` code must lint clean; `reports` code must fail with this rule's diagnostic (and,
 * when given, `check` looks at the output).
 */
export function lintRule(rule: string, options: Options = {}) {
  const [plugin, name] = rule.split("/");
  const diagnostic = plugin && name ? `${plugin}(${name})` : rule;
  return {
    allows(title: string, code: string) {
      describe(rule, () => {
        it(`allows ${title}`, () => {
          const { reported, output } = lint(rule, code, options);
          expect(reported, output).toBe(false);
        });
      });
    },
    reports(title: string, code: string, check?: (output: string) => void) {
      describe(rule, () => {
        it(`reports ${title}`, () => {
          const { reported, output } = lint(rule, code, options);
          expect(reported, output).toBe(true);
          expect(output).toContain(diagnostic);
          check?.(output);
        });
      });
    },
  };
}
