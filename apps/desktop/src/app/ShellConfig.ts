import * as Option from "effect/Option";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Config from "effect/Config";
import { OtlpHeadersFromString, OtlpProtocol } from "@kora/shared/otlp";

const trimNonEmptyOption = (val: string): Option.Option<string> => {
  const stripped = val.trim();
  return stripped.length > 0 ? Option.some(stripped) : Option.none();
};

const trimmedString = (label: string) =>
  Config.string(label).pipe(Config.option, Config.map(Option.flatMap(trimNonEmptyOption)));

const compactEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((rec): rec is [string, string] => rec[1] !== undefined),
  );

export const ShellConfig = Config.all({
  xdgDataHome: trimmedString("XDG_DATA_HOME"),
  appDataDirectory: trimmedString("APPDATA"),
  xdgConfigHome: trimmedString("XDG_CONFIG_HOME"),
  koraHome: trimmedString("KORA_HOME"),
  appFlavor: trimmedString("KORA_APP_FLAVOR"),
  disableUpdates: Config.boolean("KORA_DISABLE_UPDATES").pipe(Config.withDefault(false)),
  updateControlUrl: trimmedString("KORA_UPDATE_CONTROL_URL"),
  devServerUrl: Config.url("VITE_DEV_SERVER_URL").pipe(Config.option),
  appUserModelIdOverride: trimmedString("KORA_DESKTOP_APP_USER_MODEL_ID"),
  configuredBackendPort: Config.port("KORA_PORT").pipe(Config.option),
  commitHashOverride: trimmedString("KORA_COMMIT_HASH"),
  otlpTracesUrl: trimmedString("KORA_OTLP_TRACES_URL"),
  otlpExportIntervalMs: Config.int("KORA_OTLP_EXPORT_INTERVAL_MS").pipe(Config.withDefault(10_000)),
  otlpHeaders: Config.schema(OtlpHeadersFromString, "KORA_OTLP_HEADERS").pipe(Config.option),
  otlpProtocol: Config.schema(OtlpProtocol, "KORA_OTLP_PROTOCOL").pipe(
    Config.withDefault("http/json"),
  ),
  appImagePath: trimmedString("APPIMAGE"),
});

export const layerTest = (env: Readonly<Record<string, string | undefined>>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: compactEnv(env) }));
