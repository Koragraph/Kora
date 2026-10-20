import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ShellConfig from "./ShellConfig.ts";
import * as ShellContext from "./ShellContext.ts";

const HOME = "/Users/sam";

/** A run of the app from a source checkout at /src/kora unless `facts` says otherwise; `env` is its environment. */
const contextFor = (
  facts: Partial<ShellContext.MakeShellContextInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  ShellContext.ShellContext.pipe(
    Effect.provide(
      ShellContext.layer({
        homeDirectory: HOME,
        dirname: "/src/kora/apps/desktop/dist-electron",
        appPath: "/Applications/Kora.app/Contents/Resources/app.asar",
        resourcesPath: "/Applications/Kora.app/Contents/Resources",
        isPackaged: false,
        appVersion: "0.1.14",
        platform: "darwin",
        processArch: "arm64",
        runningUnderArm64Translation: false,
        ...facts,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(ShellConfig.layerTest(env), NodePath.layerPosix, NodeServices.layer),
        ),
      ),
    ),
  );

/** Every file the shell keeps under its state folder, relative to `KORA_HOME`. */
const statePaths = (c: ShellContext.ShellContext["Service"]) => ({
  state: c.stateDir,
  logs: c.logDir,
  artifacts: c.browserArtifactsDir,
  shellPrefs: c.desktopSettingsPath,
  clientPrefs: c.clientSettingsPath,
  daemonPrefs: c.daemonSettingsPath,
});

describe("where state lives", () => {
  it.effect("an explicit KORA_HOME (trimmed) holds everything under userdata/", () =>
    Effect.gen(function* () {
      const c = yield* contextFor({}, { KORA_HOME: "  /opt/kora-home " });
      assert.equal(c.baseDir, "/opt/kora-home");
      assert.deepEqual(statePaths(c), {
        state: "/opt/kora-home/userdata",
        logs: "/opt/kora-home/userdata/logs",
        artifacts: "/opt/kora-home/userdata/browser-artifacts",
        shellPrefs: "/opt/kora-home/userdata/shell-prefs.json",
        clientPrefs: "/opt/kora-home/userdata/client-prefs.json",
        daemonPrefs: "/opt/kora-home/userdata/settings.json",
      });
      assert.equal(c.appDataDirectory, `${HOME}/Library/Application Support`);
    }),
  );

  it.effect("without one, a dev run and a normal run never share a state folder", () =>
    Effect.gen(function* () {
      const dev = yield* contextFor({}, { VITE_DEV_SERVER_URL: "http://localhost:5173" });
      const normal = yield* contextFor();
      assert.deepEqual(
        [dev.stateDir, normal.stateDir],
        [`${HOME}/.kora/dev`, `${HOME}/.kora/userdata`],
      );
    }),
  );
});

describe("where the client comes from", () => {
  it.effect("a checkout serves apps/web/dist from its own root", () =>
    Effect.map(contextFor(), (c) =>
      assert.deepEqual(
        [c.rootDir, c.appRoot, c.clientAssetsDir],
        ["/src/kora", "/src/kora", "/src/kora/apps/web/dist"],
      ),
    ),
  );

  it.effect("a packaged app serves Resources/web, never anything under app.asar", () =>
    Effect.map(
      contextFor({
        platform: "win32",
        isPackaged: true,
        appPath: "C:/Kora/resources/app.asar",
        resourcesPath: "C:/Kora/resources",
      }),
      (c) =>
        assert.deepEqual(
          [c.appRoot, c.clientAssetsDir],
          ["C:/Kora/resources/app.asar", "C:/Kora/resources/web"],
        ),
    ),
  );
});

describe("development mode", () => {
  it.effect("only an unpackaged app with a loopback dev-server URL is a dev run", () =>
    Effect.gen(function* () {
      const cases = [
        [{ isPackaged: true }, "http://localhost:5173", false],
        [{}, "https://attacker.example/", false],
        [{}, "http://127.0.0.1:5733", true],
      ] as const;
      for (const [facts, url, dev] of cases) {
        const c = yield* contextFor(facts, { VITE_DEV_SERVER_URL: url });
        assert.equal(c.isDevelopment, dev, url);
        assert.equal(Option.isSome(c.devServerUrl), dev, url);
      }
      assert.equal(
        Option.getOrThrow(
          (yield* contextFor({}, { VITE_DEV_SERVER_URL: "http://127.0.0.1:5733" })).devServerUrl,
        ).port,
        "5733",
      );
    }),
  );

  it("loopback means 127.0.0.1, localhost or ::1, with no credentials in the URL", () => {
    const loopback = (u: string) => ShellContext.isLoopbackDevServer(new URL(u));
    assert.deepEqual(
      [
        "http://[::1]:9/",
        "http://localhost:9/",
        "http://user:pw@localhost:9/",
        "http://10.0.0.2:9/",
      ].map(loopback),
      [true, true, false, false],
    );
  });
});

describe("settings read from the environment", () => {
  it.effect("port, commit hash and trace export are parsed and trimmed", () =>
    Effect.gen(function* () {
      const c = yield* contextFor(
        {},
        {
          KORA_PORT: "4949",
          KORA_COMMIT_HASH: "  feedface0011 ",
          KORA_OTLP_TRACES_URL: " http://127.0.0.1:4318/v1/traces ",
          KORA_OTLP_EXPORT_INTERVAL_MS: "1500",
          KORA_OTLP_HEADERS: "x-tenant=kora,authorization=Bearer%20t0k%3D",
          KORA_OTLP_PROTOCOL: "http/protobuf",
        },
      );
      assert.isTrue(Option.contains(c.configuredBackendPort, 4949));
      assert.isTrue(Option.contains(c.commitHashOverride, "feedface0011"));
      assert.isTrue(Option.contains(c.otlpTracesUrl, "http://127.0.0.1:4318/v1/traces"));
      assert.deepEqual(Option.getOrNull(c.otlpHeaders), {
        "x-tenant": "kora",
        authorization: "Bearer t0k=",
      });
      assert.deepEqual([c.otlpExportIntervalMs, c.otlpProtocol], [1500, "http/protobuf"]);
    }),
  );

  it.effect("trace export defaults to JSON over HTTP", () =>
    Effect.map(contextFor(), (c) => assert.equal(c.otlpProtocol, "http/json")),
  );
});

describe("the folder picker's starting folder", () => {
  it.effect("expands ~ and drops blanks", () =>
    Effect.map(contextFor(), (c) => {
      const start = (initialPath: string | null) =>
        Option.getOrNull(
          c.resolvePickFolderDefaultPath(initialPath === null ? null : { initialPath }),
        );
      assert.deepEqual([null, "   ", "~", "~/code/acme"].map(start), [
        null,
        null,
        HOME,
        `${HOME}/code/acme`,
      ]);
    }),
  );
});
