import {
  KORA_PIERRE_ICONS,
  syntheticFileNameForLanguageId,
  resolveFileIconForEntry,
  hasSpecificFileIconForFileName,
} from "./pierre-icons";
import { assert, describe, it } from "vite-plus/test";

describe("Pierre file icons", () => {
  it("normalizes common markdown fence language aliases", () => {
    assert.equal(syntheticFileNameForLanguageId("typescript"), "file.ts");
    assert.equal(syntheticFileNameForLanguageId("shellscript"), "file.sh");
    assert.equal(syntheticFileNameForLanguageId("python"), "file.py");
  });

  it("leaves directory rendering to the shared folder fallback", () => {
    assert.isNull(resolveFileIconForEntry("packages/client-runtime", "directory"));
  });

  it("uses the Pierre default icon for unknown file types", () => {
    assert.equal(resolveFileIconForEntry("artifact.unknown-ext", "file")?.token, "default");
    assert.isFalse(hasSpecificFileIconForFileName("artifact.unknown-ext"));
  });

  it("ships every custom icon referenced by the extended resolver", () => {
    const customIconNames = new Set(
      Object.values(KORA_PIERRE_ICONS.byFileName).filter((name) => name.startsWith("kora-")),
    );
    for (const iconName of customIconNames) {
      assert.include(KORA_PIERRE_ICONS.spriteSheet, `id="${iconName}"`);
    }
  });

  it("extends Pierre with Kora-specific exact filename icons", () => {
    assert.equal(resolveFileIconForEntry("AGENTS.md", "file")?.name, "kora-file-icon-agents");
    assert.equal(resolveFileIconForEntry("pnpm-lock.yaml", "file")?.name, "kora-file-icon-pnpm");
    assert.equal(
      resolveFileIconForEntry("pnpm-workspace.yaml", "file")?.name,
      "kora-file-icon-pnpm",
    );
  });

  it("uses built-in Pierre icons where available", () => {
    assert.equal(resolveFileIconForEntry("package.json", "file")?.name, "file-tree-builtin-npm");
    assert.equal(
      resolveFileIconForEntry("config/tsconfig.json", "file")?.name,
      "file-tree-builtin-typescript",
    );
    assert.equal(resolveFileIconForEntry("CLAUDE.md", "file")?.name, "file-tree-builtin-claude");
    assert.equal(resolveFileIconForEntry("README.md", "file")?.name, "file-tree-builtin-markdown");
  });
  it("uses Pierre exact filename and complete-set extension mappings", () => {
    assert.equal(resolveFileIconForEntry("Dockerfile", "file")?.token, "docker");
    assert.equal(resolveFileIconForEntry("src/Button.tsx", "file")?.token, "react");
    assert.equal(resolveFileIconForEntry("vite.config.ts", "file")?.token, "vite");
  });
});
