import { describe, expect, it } from "vite-plus/test";

import pkg from "../package.json" with { type: "json" };
import { OPTIMIZE_DEPS_INCLUDE } from "../vite/optimizeDeps";

function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]!;
}

describe("vite optimizeDeps.include", () => {
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
  ]);

  it("only pre-bundles packages apps/web declares (no 'Failed to resolve dependency' on dev start)", () => {
    for (const specifier of OPTIMIZE_DEPS_INCLUDE) {
      expect(declared, specifier).toContain(packageNameOf(specifier));
    }
  });

  it("no longer pre-bundles Clerk, which the web client does not import", () => {
    expect(OPTIMIZE_DEPS_INCLUDE.filter((specifier) => specifier.startsWith("@clerk/"))).toEqual(
      [],
    );
  });
});
