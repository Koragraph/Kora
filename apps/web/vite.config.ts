// @effect-diagnostics nodeBuiltinImport:off -- Vite config code (plain Node), not an Effect program.
import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import * as NodeZlib from "node:zlib";
import compression from "compression";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import babel from "@rolldown/plugin-babel";
import { DEV_PROXIED_PATH_PREFIXES } from "@kora/shared/viteProxyPaths";

import { tailwindPlugins } from "./vite/tailwind.ts";
import { OPTIMIZE_DEPS_INCLUDE } from "./vite/optimizeDeps.ts";
import { loadRepoEnv } from "../../scripts/lib/repo-env.ts";
import runtimePackage from "../../packages/runtime/package.json" with { type: "json" };
import { authorizeDevProxy } from "./vite/devProxyAuth.ts";

Object.assign(process.env, { ...loadRepoEnv(), ...process.env });

const env = process.env;
const flag = (val: string | undefined) => val === "1" || val === "true";

// An explicit positive signal: baking VITE_*_URL into the bundle would pin the client to localhost
// and silently break any other origin.
const isSingleOriginDev = env.KORA_SINGLE_ORIGIN_DEV === "1";
const port = Number(env.PORT ?? 5733);
const explicitHost = env.HOST?.trim() || undefined;
const host = explicitHost ?? "localhost";
const appVersion = env.APP_VERSION || runtimePackage.version;
const wsUrl = isSingleOriginDev ? "" : (env.VITE_WS_URL ?? "");
const httpUrl = isSingleOriginDev ? "" : (env.VITE_HTTP_URL ?? "");
const bundledDev = flag(env.KORA_BUNDLED_DEV);

const sourcemap: boolean | "hidden" =
  env.KORA_WEB_SOURCEMAP === "0" || env.KORA_WEB_SOURCEMAP === "false"
    ? false
    : env.KORA_WEB_SOURCEMAP === "hidden"
      ? "hidden"
      : true;

const allowedHosts = [
  ".ts.net",
  ...(env.KORA_DEV_ALLOWED_HOSTS?.split(",")
    .map((h) => h.trim())
    .filter(Boolean) ?? []),
];

function proxyTarget(): string | undefined {
  const daemonPort = Number(env.KORA_PORT);
  if (Number.isInteger(daemonPort) && daemonPort > 0) return `http://localhost:${daemonPort}/`;
  if (!wsUrl) return undefined;
  const address = new URL(wsUrl);
  address.protocol = address.protocol === "wss:" ? "https:" : "http:";
  address.pathname = "/";
  address.search = "";
  address.hash = "";
  return address.toString();
}

function devProxy() {
  const dest = proxyTarget();
  if (!dest) return undefined;
  const websocketPrefixes = new Set(["/ws", "/api", "/blob-browser"]);
  return Object.fromEntries(
    DEV_PROXIED_PATH_PREFIXES.map((lead) => [
      lead,
      {
        target: dest,
        changeOrigin: true,
        configure: authorizeDevProxy,
        ...(websocketPrefixes.has(lead) ? { ws: true } : {}),
      },
    ]),
  );
}

// Bundled dev serves ~25 MB chunks; brotli quality 11 would stall encoding, 5 keeps it quick.
const devCompression = {
  name: "kora:dev-compression",
  apply: "serve" as const,
  configureServer(server: { middlewares: { use(fn: unknown): void } }) {
    server.middlewares.use(
      compression({
        brotli: { enabled: true, params: { [NodeZlib.constants.BROTLI_PARAM_QUALITY]: 5 } },
      } as never),
    );
  },
};

const devProxyConfig = devProxy();

const reactCompilerBabel = babel({
  presets: [reactCompilerPreset()],
  parserOpts: { plugins: ["typescript", "jsx"] },
});

export default defineConfig(() => ({
  plugins: [
    devCompression,
    tanstackRouter({ autoCodeSplitting: true }),
    react(),
    reactCompilerBabel,
    tailwindPlugins(bundledDev),
  ],
  optimizeDeps: { include: [...OPTIMIZE_DEPS_INCLUDE] },
  resolve: { tsconfigPaths: true, dedupe: ["react", "react-dom"] },
  define: {
    "import.meta.env.VITE_WS_URL": JSON.stringify(wsUrl),
    "import.meta.env.VITE_HTTP_URL": JSON.stringify(httpUrl),
    "import.meta.env.APP_VERSION": JSON.stringify(appVersion),
  },
  ...(bundledDev ? { experimental: { bundledDev: true } } : {}),
  server: {
    host,
    port,
    strictPort: true,
    allowedHosts,
    // Transform the whole graph at startup instead of on the first request.
    warmup: { clientFiles: ["./src/main.tsx"] },
    ...(devProxyConfig === undefined ? {} : { proxy: devProxyConfig }),
    // Electron needs the HMR socket pinned; elsewhere it follows the page origin (LAN, Tailscale).
    ...(explicitHost ? { hmr: { protocol: "ws", host: explicitHost, clientPort: port } } : {}),
  },
  css: { devSourcemap: sourcemap !== false },
  build: {
    rolldownOptions: {
      output: {
        // Hash-only names: the shipped bundle must not mirror source file names.
        entryFileNames: "assets/e-[hash].js",
        chunkFileNames: "assets/c-[hash].js",
        assetFileNames: "assets/a-[hash][extname]",
      },
    },
    sourcemap,
    manifest: true,
    emptyOutDir: true,
    outDir: "dist",
  },
  test: {
    projects: [
      {
        extends: true as const,
        test: {
          setupFiles: ["../../packages/shared/src/testing/deepTempDir.ts"],
          testTimeout: 15_000,
          // Websocket lifecycle tests outlast 5 s when the whole monorepo suite is running.
          hookTimeout: 15_000,
          include: ["src/**/*.test.{ts,tsx}"],
          name: "unit",
        },
      },
    ],
  },
}));
