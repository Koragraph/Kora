// @effect-diagnostics nodeBuiltinImport:off -- Exercises a plain-node script on real temp directories.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

// The script ships inside the bundle and runs under its node (resources/kora-runtime-manifest.cjs).
const require = NodeModule.createRequire(import.meta.url);
const { generateManifest, verifyRuntime } =
  require("../../resources/kora-runtime-manifest.cjs") as {
    generateManifest: (
      dir: string,
      buildId?: string,
    ) => Promise<{ files: Record<string, unknown> }>;
    verifyRuntime: (copy: string, manifest: unknown, bundle?: string) => Promise<string[]>;
  };

const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4]);
const roots: string[] = [];

function makeRuntime(): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-runtime-manifest-"));
  roots.push(root);
  NodeFS.mkdirSync(NodePath.join(root, "bin"));
  NodeFS.mkdirSync(NodePath.join(root, "node_modules", "pkg"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, "bin", "kora.js"), "console.log('kora');\n");
  NodeFS.writeFileSync(NodePath.join(root, "bin", "node"), MACHO, { mode: 0o755 });
  NodeFS.writeFileSync(
    NodePath.join(root, "node_modules", "pkg", "index.js"),
    "module.exports = 1;\n",
  );
  NodeFS.writeFileSync(NodePath.join(root, "node_modules", "pkg", "README.md"), "readme\n");
  NodeFS.symlinkSync("pkg", NodePath.join(root, "node_modules", "alias"));
  NodeFS.writeFileSync(NodePath.join(root, "BUILD_ID"), "0.1.3-test\n");
  return root;
}

function copyRuntime(source: string): string {
  const target = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kora-runtime-copy-"));
  roots.push(target);
  NodeFS.cpSync(source, target, { recursive: true, verbatimSymlinks: true });
  return target;
}

afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("kora runtime integrity manifest", () => {
  // Mach-O binaries and exec bits: the manifest is macOS-only for now (docs/windows/PORT.md).
  // oxlint-disable-next-line kora/no-global-process-runtime -- a test skip condition, decided before any runtime exists
  it.skipIf(process.platform === "win32")(
    "flags Mach-O files for a bundle comparison instead of hashing them",
    async () => {
      const manifest = await generateManifest(makeRuntime(), "0.1.3-test");
      expect(manifest.files["bin/node"]).toEqual({ t: "f", x: true, m: 1 });
      expect(manifest.files["bin/kora.js"]).toMatchObject({ t: "f", x: false });
      expect(manifest.files["node_modules/alias"]).toEqual({ t: "l", to: "pkg" });
    },
  );

  it("accepts an untouched copy (and harmless extra data files)", async () => {
    const bundle = makeRuntime();
    const manifest = await generateManifest(bundle);
    const copy = copyRuntime(bundle);
    NodeFS.writeFileSync(NodePath.join(copy, "node_modules", "pkg", "notes.txt"), "cache\n");
    await expect(verifyRuntime(copy, manifest, bundle)).resolves.toEqual([]);
  });

  // oxlint-disable-next-line kora/no-global-process-runtime -- a test skip condition, decided before any runtime exists
  it.skipIf(process.platform === "win32")(
    "catches edited JS, added code, swapped binaries, retargeted symlinks and missing files",
    async () => {
      const bundle = makeRuntime();
      const manifest = await generateManifest(bundle);
      const copy = copyRuntime(bundle);
      NodeFS.appendFileSync(
        NodePath.join(copy, "bin", "kora.js"),
        "require('child_process').exec('evil');\n",
      );
      NodeFS.writeFileSync(
        NodePath.join(copy, "node_modules", "pkg", "postinstall.js"),
        "evil();\n",
      );
      NodeFS.writeFileSync(
        NodePath.join(copy, "bin", "node"),
        Buffer.concat([MACHO, Buffer.from([9])]),
      );
      NodeFS.unlinkSync(NodePath.join(copy, "node_modules", "alias"));
      NodeFS.symlinkSync("/tmp", NodePath.join(copy, "node_modules", "alias"));
      NodeFS.unlinkSync(NodePath.join(copy, "node_modules", "pkg", "README.md"));
      NodeFS.writeFileSync(NodePath.join(copy, "helper"), "#!/bin/sh\n", { mode: 0o755 });

      const problems = await verifyRuntime(copy, manifest, bundle);
      expect(problems).toEqual(
        expect.arrayContaining([
          "modified: bin/kora.js",
          "unexpected file: node_modules/pkg/postinstall.js",
          "modified: bin/node",
          "symlink retargeted: node_modules/alias",
          "missing: node_modules/pkg/README.md",
          "unexpected file: helper",
        ]),
      );
    },
  );

  it("ignores mode-only changes (node-pty chmods its spawn-helper at runtime)", async () => {
    const bundle = makeRuntime();
    const helper = NodePath.join(bundle, "node_modules", "pkg", "spawn-helper");
    NodeFS.writeFileSync(helper, "helper\n", { mode: 0o644 });
    const manifest = await generateManifest(bundle);
    const copy = copyRuntime(bundle);
    NodeFS.chmodSync(NodePath.join(copy, "node_modules", "pkg", "spawn-helper"), 0o755);
    await expect(verifyRuntime(copy, manifest, bundle)).resolves.toEqual([]);
    NodeFS.appendFileSync(NodePath.join(copy, "node_modules", "pkg", "spawn-helper"), "evil\n");
    await expect(verifyRuntime(copy, manifest, bundle)).resolves.toEqual([
      "modified: node_modules/pkg/spawn-helper",
    ]);
  });

  it("fails closed on a missing or foreign manifest", async () => {
    const bundle = makeRuntime();
    await expect(verifyRuntime(bundle, null, bundle)).resolves.not.toEqual([]);
    await expect(verifyRuntime(bundle, { v: 99, files: {} }, bundle)).resolves.not.toEqual([]);
  });
});
