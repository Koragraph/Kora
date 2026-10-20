import * as Option from "effect/Option";

export type JoinPath = (head: string, ...pieces: string[]) => string;

function normalizeConfiguredBaseDir(koraHome: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(koraHome)) {
    return Option.none();
  }
  const stripped = koraHome.value.trim();
  return stripped.length > 0 ? Option.some(stripped) : Option.none();
}

export function resolveShellBaseDir(options: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly koraHome: Option.Option<string>;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(options.koraHome), () =>
    options.joinPath(options.homeDirectory, ".kora"),
  );
}

export function resolveShellStateDir(options: {
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly koraHome: Option.Option<string>;
  readonly baseDir: string;
}): string {
  const useDevSubdir =
    options.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(options.koraHome));
  return options.joinPath(options.baseDir, useDevSubdir ? "dev" : "userdata");
}
