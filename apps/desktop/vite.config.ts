import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

import { pickMainWorldPlugin } from "./scripts/pick-main-world-plugin.ts";
import { isDesktopRuntimeExternalDependency } from "../../scripts/lib/desktop-external-packages.ts";

// The main process is bundled the same way the server CLI is: every JS
// dependency is inlined and only packages Node must load from disk stay
// external. The packaged app then installs just those externals, instead of a
// full production install of apps/desktop's dependency tree next to a server
// bundle that already carries its own copy of the same libraries.
const isMainProcessExternal = (ident: string) =>
  ident === "electron" ||
  ident.startsWith("electron/") ||
  isDesktopRuntimeExternalDependency(ident);
// Shipped minified with function/class names kept (crash logs stay readable). The .map files stay in the checkout —
// package-app.sh strips *.map — to decode a tester's stack trace for that exact build.
const SHIPPED_OUTPUT = { minify: true, keepNames: true } as const;
const shouldLaunchElectronAfterPack = process.env.KORA_DESKTOP_DEV === "1";

export default defineConfig({
  run: {
    tasks: {
      "dev:electron": {
        command: "node scripts/dev.mjs",
        cache: false,
      },
      "dev:bundle": {
        command: "node scripts/build-markup-css.mjs && vp pack --watch",
        cache: false,
      },
      dev: {
        command:
          "node scripts/build-markup-css.mjs && cross-env KORA_DESKTOP_DEV=1 vp pack --watch",
        cache: false,
      },
      build: {
        cache: false,
        command: "node scripts/build-markup-css.mjs && vp pack",
      },
    },
  },
  pack: [
    {
      outExtensions: () => ({ js: ".cjs" }),
      sourcemap: true,
      dts: false,
      outDir: "dist-electron",
      format: "cjs",
      outputOptions: { codeSplitting: false, ...SHIPPED_OUTPUT },
      entry: ["src/main.ts"],
      clean: true,
      deps: {
        onlyBundle: false,
        neverBundle: isMainProcessExternal,
        alwaysBundle: (ident) => !ident.startsWith("node:") && !isMainProcessExternal(ident),
      },
      ...(shouldLaunchElectronAfterPack ? { onSuccess: "node scripts/dev.mjs" } : {}),
    },
    {
      entry: ["src/preload.ts"],
      outExtensions: () => ({ js: ".cjs" }),
      outputOptions: SHIPPED_OUTPUT,
      sourcemap: true,
      dts: false,
      outDir: "dist-electron",
      format: "cjs",
    },
    {
      outExtensions: () => ({ js: ".cjs" }),
      outputOptions: SHIPPED_OUTPUT,
      sourcemap: true,
      dts: false,
      outDir: "dist-electron",
      format: "cjs",
      entry: ["src/web-pick-preload.ts"],
      // The picker preload runs isolated; react-grab is bundled into the
      // separate main-world script this plugin inlines as a string.
      plugins: [pickMainWorldPlugin()],
    },
    {
      entry: ["src/web-pip-preload.ts"],
      outExtensions: () => ({ js: ".cjs" }),
      outputOptions: SHIPPED_OUTPUT,
      sourcemap: true,
      dts: false,
      outDir: "dist-electron",
      format: "cjs",
    },
  ],
  test: {
    // The Windows lane runs workspace suites concurrently; filesystem-heavy
    // desktop integration tests can exceed Vitest's 5 second default there.
    testTimeout: 15_000,
    setupFiles: ["../../packages/shared/src/testing/deepTempDir.ts"],
  },
});
