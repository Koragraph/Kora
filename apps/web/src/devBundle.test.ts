// @effect-diagnostics nodeBuiltinImport:off - builds and executes real dev bundles on disk.
import react from "@vitejs/plugin-react";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { createLogger, createServer } from "vite-plus";
import { describe, expect, it } from "vite-plus/test";

const nextEvent = (bus: NodeEvents.EventEmitter, name: string) =>
  new Promise<void>((resolve) => bus.once(name, () => resolve()));

import { tailwindPlugins } from "../vite/tailwind";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);
type ViteDevServer = Awaited<ReturnType<typeof createServer>>;
type RegisterCleanup = (cleanup: () => unknown) => void;

/** Runs `body` in a throwaway directory; every registered cleanup runs (newest first) before it is deleted. */
async function withTempProject(
  prefix: string,
  body: (directory: string, onCleanup: RegisterCleanup) => Promise<void>,
) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  const cleanups: Array<() => unknown> = [];
  try {
    await body(directory, (cleanup) => cleanups.push(cleanup));
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}

const relativeToTests = (path: string) => new URL(path, import.meta.url);

async function startListening(server: ViteDevServer): Promise<number> {
  await server.listen();
  const localUrl = server.resolvedUrls?.local[0];
  if (!localUrl) throw new Error("the dev server did not report a local URL");
  return Number(new URL(localUrl).port);
}

/** Connects as a Vite HMR client and translates the server's messages into events on `bus`. */
function connectHmrClient(
  server: ViteDevServer,
  port: number,
  bus: NodeEvents.EventEmitter,
  onCleanup: RegisterCleanup,
) {
  server.ws.on("vite:client-connected", () => bus.emit("connected"));
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/?token=${server.config.webSocketToken}`,
    "vite-hmr",
  );
  onCleanup(() => socket.close());
  socket.addEventListener("open", () =>
    socket.send(
      JSON.stringify({
        event: "vite:client-connected",
        type: "custom",
        data: { clientId: "hmr-test" },
      }),
    ),
  );
  socket.addEventListener("message", ({ data }) => {
    const message: unknown = JSON.parse(String(data));
    if (message === null || typeof message !== "object" || !("type" in message)) return;
    if (message.type === "full-reload" && "ifFallback" in message && message.ifFallback === true) {
      bus.emit("ready");
    } else if (message.type === "bundled-dev-update") {
      bus.emit("updated");
    }
  });
}

/** An ES-module script that boots the generated bundle under stubbed browser/HMR globals. */
const bootCheckScript = [
  'import assert from "node:assert/strict";',
  "const started = Promise.withResolvers();",
  "globalThis.onStarted = started.resolve;",
  "console.error = (_message, error) => started.reject(error);",
  "globalThis.window = globalThis;",
  "globalThis.document = {",
  "  getElementById: () => null,",
  "  createElement: () => ({ relList: { supports: () => true } }),",
  "};",
  "const noop = () => {};",
  "globalThis.__rolldown_runtime__ = {",
  "  registerGraph: noop,",
  "  registerModule: noop,",
  "  createModuleHotContext: () => ({ accept: noop }),",
  "};",
  'await import("./assets/index.js");',
  "const view = await started.promise;",
  'assert.equal(view.props.children, "ready");',
  'assert.equal(typeof window.$RefreshReg$, "function");',
  'console.log("App started with React refresh ready.");',
].join("\n");

describe("bundled dev mode", () => {
  it("hot-updates Tailwind output when a source file's class changes", async () => {
    await withTempProject("kora-tw-hmr-", async (root, onCleanup) => {
      const bus = new NodeEvents.EventEmitter();
      const entrySource =
        'import "./style.css"; export const pad = "pt-[21px]"; import.meta.hot?.accept();';
      await NodeFSP.writeFile(
        NodePath.join(root, "index.html"),
        '<html><body><script type="module" src="/main.ts"></script></body></html>',
      );
      await NodeFSP.writeFile(NodePath.join(root, "main.ts"), entrySource);
      await NodeFSP.writeFile(
        NodePath.join(root, "style.css"),
        '@import "tailwindcss" source(none); @source "./main.ts";',
      );

      const logger = createLogger("silent");
      logger.error = (message) => bus.emit("error", new Error(message));
      const hmrClientReady = nextEvent(bus, "connected");
      const initialBuildServed = nextEvent(bus, "ready");
      let latestCss = "";

      const server = await createServer({
        root,
        configFile: false,
        customLogger: logger,
        experimental: { bundledDev: true },
        server: { host: "127.0.0.1", port: 0 },
        resolve: {
          alias: {
            tailwindcss: NodeURL.fileURLToPath(
              relativeToTests("../node_modules/tailwindcss/index.css"),
            ),
          },
        },
        plugins: [
          ...tailwindPlugins(true),
          {
            name: "record-tailwind-output",
            enforce: "pre",
            transform(code, id) {
              if (id.endsWith("/style.css")) latestCss = code;
            },
            // Keep the first build open until the HMR socket can receive Vite's ready message.
            generateBundle: async () => void (await hmrClientReady),
          },
        ],
      });
      onCleanup(() => server.close());
      const port = await startListening(server);
      connectHmrClient(server, port, bus, onCleanup);
      await hmrClientReady;
      await initialBuildServed;

      const entryResponse = await fetch(`http://127.0.0.1:${port}/assets/index.js`);
      expect(entryResponse.headers.get("content-type")).toContain("javascript");
      await entryResponse.text();

      const updateApplied = nextEvent(bus, "updated");
      await NodeFSP.writeFile(NodePath.join(root, "main.ts"), entrySource.replace("21px", "213px"));
      await updateApplied;

      expect(latestCss).toContain("padding-top: 213px");
    });
  });

  it("sets up React refresh before a shared UI chunk executes", async () => {
    await withTempProject("kora-refresh-order-", async (root, onCleanup) => {
      const outputDir = NodePath.join(root, "output");
      let deliverChunks!: (files: Map<string, string>) => void;
      let failChunks!: (error: unknown) => void;
      const chunkFiles = new Promise<Map<string, string>>((resolve, reject) => {
        deliverChunks = resolve;
        failChunks = reject;
      });

      await NodeFSP.mkdir(NodePath.join(root, "src/util"), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(root, "package.json"), '{"type":"module"}');
      for (const file of [
        "index.html",
        "src/startup.ts",
        "src/storageMigrations.ts",
        "src/util/bootError.ts",
      ]) {
        await NodeFSP.copyFile(relativeToTests(`../${file}`), NodePath.join(root, file));
      }
      await NodeFSP.writeFile(
        NodePath.join(root, "src/shared.tsx"),
        "export function Shared() { return <div>ready</div>; }",
      );
      await NodeFSP.writeFile(
        NodePath.join(root, "src/main.tsx"),
        `import { Shared } from "./shared";
export const startup = Promise.resolve().then(() => globalThis.onStarted(Shared()));`,
      );

      const server = await createServer({
        root,
        configFile: false,
        logLevel: "silent",
        publicDir: NodeURL.fileURLToPath(relativeToTests("../public")),
        experimental: { bundledDev: true },
        server: { host: "127.0.0.1", port: 0 },
        resolve: {
          alias: { react: NodePath.dirname(NodeURL.fileURLToPath(import.meta.resolve("react"))) },
        },
        build: {
          rolldownOptions: {
            // eager devMode so every chunk is emitted up front
            experimental: {
              devMode: { lazy: false },
            },
            output: {
              // Produces the shared chunks that lazy routes create at runtime, with no browser needed.
              codeSplitting: {
                // vendor first, then the shared UI chunk
                groups: [
                  { priority: 10, name: "vendor", test: /node_modules|@react-refresh/ },
                  {
                    includeDependenciesRecursively: false,
                    name: "shared-ui",
                    test: /shared\.tsx$/,
                  },
                ],
              },
            },
          },
        },
        plugins: [
          react(),
          {
            name: "collect-bootstrap-chunks",
            buildEnd: (error) => void (error && failChunks(error)),
            generateBundle(_options, bundle) {
              deliverChunks(
                new Map(
                  Object.values(bundle)
                    .filter((output) => output.type === "chunk")
                    .map((chunk) => [chunk.fileName, chunk.code]),
                ),
              );
            },
          },
        ],
      });
      onCleanup(() => server.close());
      await startListening(server);

      for (const [fileName, code] of await chunkFiles) {
        const target = NodePath.join(outputDir, fileName);
        await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
        await NodeFSP.writeFile(target, code);
      }

      // Run the generated modules for real so import order and the refresh checks execute;
      // only the browser and the HMR transport are stubbed.
      const script = NodePath.join(outputDir, "check.mjs");
      await NodeFSP.writeFile(script, bootCheckScript);
      const { stdout } = await execFileAsync("node", [script]);

      expect(stdout).toContain("App started with React refresh ready.");
    });
  });
});
