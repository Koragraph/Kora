// @effect-diagnostics nodeBuiltinImport:off - Drives the real Knip CLI over a throwaway project on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const knipCli = NodePath.join(
  NodePath.dirname(NodeModule.createRequire(import.meta.url).resolve("knip")),
  "cli.js",
);
const PREPROCESSOR = NodePath.join(import.meta.dirname, "knip-keep-schemas.ts");
const KINDS = "files,dependencies,exports,nsExports,types,nsTypes,duplicates";

const manifest = {
  type: "module",
  private: true,
  dependencies: { effect: "*" } as Record<string, string>,
};

type Finding = { file: string } & Record<string, Array<{ name: string }>>;

// The project lives next to this file so it resolves the same `effect` the scripts do.
let dir = "";
const put = (file: string, body: string) => NodeFS.writeFileSync(NodePath.join(dir, file), body);
const knip = (withPreprocessor: boolean) => {
  const flags = `--reporter json --no-config-hints --include ${KINDS}`.split(" ");
  const where = ["--directory", dir, "--config", NodePath.join(dir, "knip.json")];
  const extra = withPreprocessor ? ["--preprocessor", PREPROCESSOR] : [];
  const run = NodeChildProcess.spawnSync(
    process.execPath,
    [knipCli, ...where, ...flags, ...extra],
    {
      encoding: "utf8",
    },
  );
  return {
    code: run.status,
    out: run.stdout,
    err: run.stderr,
    findings: () => JSON.parse(run.stdout).issues as Finding[],
  };
};

beforeAll(() => {
  dir = NodeFS.mkdtempSync(NodePath.join(import.meta.dirname, ".knip-fixture-"));
  put(
    "package.json",
    JSON.stringify({ private: true, type: "module", dependencies: { effect: "*" } }),
  );
  put("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, module: "NodeNext" } }));
  put(
    "knip.json",
    JSON.stringify({
      project: ["*.ts"],
      entry: ["main.ts"],
      includeEntryExports: true,
      include: KINDS.split(","),
      rules: { types: "off", nsTypes: "off" },
    }),
  );
  // Every kind of schema export, none of them imported anywhere.
  put(
    "main.ts",
    [
      'import * as Schema from "effect/Schema";',
      'import * as more from "./more.ts";',
      "console.log(more);",
      'export { Wire as WireAgain } from "./wire.ts";',
      "export const Name = Schema.String;",
      "export const NameAlias = Name;",
      "const Hidden = Schema.Boolean;",
      "export type Hidden = typeof Hidden.Type;",
      "export const HiddenAlias = Hidden;",
      "export default Name;",
      'export const Pair = Schema.Struct({ name: Name }).annotate({ title: "pair" });',
      'export const Tagged = Schema.String.pipe(Schema.brand("Tag"));',
      'export class Oops extends Schema.TaggedError<Oops>()("Oops", { why: Name }) {}',
      'export class User extends Schema.Class<User>("User")({ name: Name }) {}',
      "export type Shape = { name: string };",
      "export interface Contract { name: string }",
      "",
    ].join("\n"),
  );
  // Running this module would throw: the preprocessor must only read types.
  put(
    "wire.ts",
    'import { Schema } from "effect";\nexport const Wire = Schema.Struct({ id: Schema.Number });\nthrow new Error("evaluated");\n',
  );
  put(
    "more.ts",
    'import * as Schema from "effect/Schema";\nexport const Spare = Schema.Number;\nexport type Spare = string;\n',
  );
});
afterAll(() => NodeFS.rmSync(dir, { recursive: true, force: true }));

describe("the schema-keeping Knip preprocessor", () => {
  it("clears findings that are only schemas", () => {
    const plain = knip(false);
    expect(plain.code, plain.err).toBe(1);
    expect(plain.out).toContain('"Name"');
    const kept = knip(true);
    expect(kept.code, kept.err + kept.out).toBe(0);
    expect(kept.findings()).toEqual([]);
  });

  it("still reports everything that is not a schema", () => {
    NodeFS.appendFileSync(
      NodePath.join(dir, "main.ts"),
      [
        "export const parse = Schema.decodeUnknownSync(Name);",
        "export const schemaFactory = () => Schema.String;",
        'export const NotASchema = { ast: "no" };',
        "export const plainNumber = 7;",
        "export const sameNumber = plainNumber;",
        "",
      ].join("\n"),
    );
    NodeFS.appendFileSync(NodePath.join(dir, "more.ts"), "export const helper = () => 0;\n");
    put("orphan.ts", "export const orphan = 1;\n");
    const withStrayDep = {
      ...manifest,
      dependencies: { ...manifest.dependencies, "not-a-real-dep": "*" },
    };
    put("package.json", JSON.stringify(withStrayDep));

    const run = knip(true);
    expect(run.code, run.err).toBe(1);
    const at = (file: string) => run.findings().find((f) => f.file === file)!;
    expect(
      at("main.ts")
        .exports!.map((e) => e.name)
        .toSorted(),
    ).toEqual(["NotASchema", "parse", "plainNumber", "sameNumber", "schemaFactory"]);
    expect(at("main.ts").duplicates).toHaveLength(1);
    expect(at("more.ts").nsExports!.map((e) => e.name)).toEqual(["helper"]);
    expect(at("orphan.ts").files).toHaveLength(1);
    expect(at("package.json").dependencies!.map((d) => d.name)).toEqual(["not-a-real-dep"]);
  });
});
