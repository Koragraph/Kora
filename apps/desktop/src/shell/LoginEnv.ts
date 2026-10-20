// A GUI-launched app inherits almost no environment: no PATH from the user's shell profile, no locale. Before
// anything is spawned (the daemon, agents, CLIs) the user's login shell is asked for the few variables that matter
// and they are merged into this process's environment. Nothing here can fail startup.
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Context from "effect/Context";

import * as ShellTracing from "../app/ShellTracing.ts";
import * as ShellContext from "../app/ShellContext.ts";

const { logWarning } = ShellTracing.makeScopedLogger("desktop-shell-environment");

const SHELL_PROBE_TIMEOUT = Duration.seconds(5);
const LAUNCHCTL_TIMEOUT = Duration.seconds(2);
const KILL_GRACE = Duration.seconds(1);
const FALLBACK_LOCALE = "en_US.UTF-8";

const PROBED_NAMES = [
  "PATH",
  "HOMEBREW_REPOSITORY",
  "HOMEBREW_CELLAR",
  "HOMEBREW_PREFIX",
  "SSH_AUTH_SOCK",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
] as const;
type ProbedName = (typeof PROBED_NAMES)[number];
type Probed = Partial<Record<ProbedName, string>>;

const probeKinds = Schema.Literals(["login-shell", "launchctl-path"]);

export class LoginEnvCommandError extends Schema.TaggedError<LoginEnvCommandError>()(
  "LoginEnvCommandError",
  {
    cause: Schema.Defect(),
    argumentCount: Schema.Number,
    executable: Schema.String,
    probe: probeKinds,
  },
) {
  override get message() {
    return `Desktop shell environment ${this.probe} probe (${this.executable}) failed.`;
  }
}

export class LoginEnvCommandTimeoutError extends Schema.TaggedError<LoginEnvCommandTimeoutError>()(
  "LoginEnvCommandTimeoutError",
  {
    probe: probeKinds,
    executable: Schema.String,
    argumentCount: Schema.Number,
    timeoutMs: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Desktop shell environment ${this.probe} probe (${this.executable}) timed out after ${this.timeoutMs}ms.`;
  }
}

export class LoginEnv extends Context.Service<
  LoginEnv,
  { readonly installIntoProcess: Effect.Effect<void> }
>()("@kora/desktop/shell/LoginEnv") {}

// Each variable is wrapped in marker lines because shell start-up files are free to print anything.
const startMarker = (label: string) => `__KORA_ENV_${label}_START__`;
const endMarker = (label: string) => `__KORA_ENV_${label}_END__`;

const captureScript = PROBED_NAMES.map(
  (label) => `echo ${startMarker(label)}; printenv ${label} || true; echo ${endMarker(label)}`,
).join("; ");

function parseProbeOutput(emitted: string): Probed {
  const located: Probed = {};
  for (const label of PROBED_NAMES) {
    const startAt = emitted.indexOf(startMarker(label));
    if (startAt === -1) continue;
    const valueStart = startAt + startMarker(label).length;
    const destination = emitted.indexOf(endMarker(label), valueStart);
    if (destination === -1) continue;
    const val = emitted
      .slice(valueStart, destination)
      .replace(/^\r?\n/, "")
      .replace(/\r?\n$/, "");
    if (val.length > 0) located[label] = val;
  }
  return located;
}

function mergePath(...lists: ReadonlyArray<string | undefined>): string {
  const visited = new Set<string>();
  for (const arr of lists) {
    for (const fragment of (arr ?? "").split(":")) {
      const rec = fragment.trim();
      if (rec.length > 0) visited.add(rec);
    }
  }
  return [...visited].join(":");
}

const basename = (executable: string) => executable.split("/").pop() ?? executable;

const make = Effect.gen(function* () {
  const envVars = yield* ShellContext.ShellContext;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  // Run a command with stdin closed and return what it printed; every failure becomes "" plus a warning.
  const capture = (
    probe: LoginEnvCommandError["probe"],
    executable: string,
    argv: ReadonlyArray<string>,
    timeout: Duration.Duration,
  ): Effect.Effect<string> => {
    const fail = (reason: unknown) =>
      new LoginEnvCommandError({
        probe,
        executable: basename(executable),
        argumentCount: argv.length,
        cause: reason,
      });
    const exec = Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* ChildProcess.make(executable, argv, {
          stdin: "ignore",
          killSignal: "SIGTERM",
          forceKillAfter: KILL_GRACE,
        });
        return yield* handle.stdout.pipe(Stream.decodeText(), Stream.mkString);
      }),
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

    return exec.pipe(
      Effect.timeoutOption(timeout),
      Effect.mapError(fail),
      Effect.flatMap((timed) =>
        timed._tag === "Some"
          ? Effect.succeed(timed.value)
          : logWarning(
              new LoginEnvCommandTimeoutError({
                probe,
                executable: basename(executable),
                argumentCount: argv.length,
                timeoutMs: Duration.toMillis(timeout),
                cause: "timeout",
              }).message,
            ).pipe(Effect.as("")),
      ),
      Effect.catch((err) => Effect.logWarning(err.message, err).pipe(Effect.as(""))),
    );
  };

  const installOnMac = Effect.gen(function* () {
    const env = process.env;
    const shells = [
      // oxlint-disable-next-line kora/no-posix-only-paths -- installOnMac: the macOS default login shell
      ...new Set([env.SHELL?.trim() ?? "", "/bin/zsh"].filter((shell) => shell.length > 0)),
    ];

    // Interactive login shells, so rc files run; the first one that knows a PATH wins.
    let fromShell: Probed = {};
    for (const sh of shells) {
      const emitted = yield* capture(
        "login-shell",
        sh,
        ["-ilc", captureScript],
        SHELL_PROBE_TIMEOUT,
      );
      fromShell = { ...parseProbeOutput(emitted), ...fromShell };
      if (fromShell.PATH !== undefined) break;
    }
    let probedPath = fromShell.PATH;
    if (probedPath === undefined) {
      const emitted = yield* capture(
        "launchctl-path",
        "/bin/launchctl",
        ["getenv", "PATH"],
        LAUNCHCTL_TIMEOUT,
      );
      probedPath = emitted.trim() || undefined;
    }

    const existingPath = env.PATH ?? env.Path ?? env.path;
    const combined = mergePath(probedPath, existingPath);
    if (combined.length > 0) env.PATH = combined;

    const inheritedFromShell = [
      "HOMEBREW_REPOSITORY",
      "HOMEBREW_CELLAR",
      "HOMEBREW_PREFIX",
      "SSH_AUTH_SOCK",
    ] as const;
    for (const label of inheritedFromShell) {
      const val = fromShell[label];
      if (!env[label] && val) env[label] = val;
    }

    // LANG, LC_ALL and LC_CTYPE form one precedence group, so take them from the shell only as a whole.
    const localeNames = ["LANG", "LC_ALL", "LC_CTYPE"] as const;
    if (!localeNames.some((label) => env[label])) {
      for (const label of localeNames) {
        const val = fromShell[label];
        if (val) env[label] = val;
      }
    }
    // A GUI launch has no locale at all, so agents run in the C locale and pbcopy reads their UTF-8 as MacRoman.
    // Only LC_CTYPE is set: LANG stays unset to keep collation and number formatting stable for output parsing.
    if (!localeNames.some((label) => env[label])) env.LC_CTYPE = FALLBACK_LOCALE;
  });

  return LoginEnv.of({
    installIntoProcess: (envVars.platform === "darwin" ? installOnMac : Effect.void).pipe(
      Effect.withSpan("shell.shellHost.installIntoProcess"),
    ),
  });
});

export const layer = Layer.effect(LoginEnv, make);
