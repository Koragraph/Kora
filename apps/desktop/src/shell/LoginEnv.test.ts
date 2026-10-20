import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Logger, PlatformError, Schema, Sink, Stream } from "effect";
import type * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ShellContext from "../app/ShellContext.ts";
import * as LoginEnv from "./LoginEnv.ts";

// A Mac app launched from the Dock gets launchd's bare environment, not the user's shell's. LoginEnv asks the
// login shell (then fallbacks) for PATH, the SSH agent and the locale, and fills in what the app is missing.

/** What a login shell prints for the variables it is asked about (each value between markers). */
const shellPrints = (values: Readonly<Record<string, string>>) =>
  Object.entries(values)
    .map(([name, value]) => `__KORA_ENV_${name}_START__\n${value}\n__KORA_ENV_${name}_END__`)
    .join("\n");

/** A process that has already exited 0 after writing `stdout`. */
const exited = (stdout: string): ChildProcessSpawner.ChildProcessHandle => {
  const out = stdout === "" ? Stream.empty : Stream.make(new TextEncoder().encode(stdout));
  const nothing = { stderr: Stream.empty, stdin: Sink.drain, kill: () => Effect.void };
  return ChildProcessSpawner.makeHandle({
    ...nothing,
    stdout: out,
    all: out,
    pid: ChildProcessSpawner.ProcessId(4242),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    unref: Effect.succeed(Effect.void),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
};

/**
 * Installs the login environment into `env` (standing in for `process.env`, restored afterwards) on macOS.
 * `answer` says what each spawned command prints; `spawnFails` makes every spawn fail instead.
 */
const install = (
  env: NodeJS.ProcessEnv,
  answer: (command: ChildProcess.Command) => string,
  spawnFails?: PlatformError.PlatformError,
) => {
  const spawner = ChildProcessSpawner.make((command) =>
    spawnFails ? Effect.fail(spawnFails) : Effect.sync(() => exited(answer(command))),
  );
  const deps = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(ShellContext.ShellContext, {
      platform: "darwin",
    } as ShellContext.ShellContext["Service"]),
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );
  const run = Effect.flatMap(LoginEnv.LoginEnv, (login) => login.installIntoProcess).pipe(
    Effect.provide(LoginEnv.layer.pipe(Layer.provide(deps))),
  );
  const real = process.env;
  return Effect.ensuring(
    Effect.andThen(
      Effect.sync(() => void (process.env = env)),
      run,
    ),
    Effect.sync(() => void (process.env = real)),
  );
};

const BREW_PATH = "/opt/homebrew/bin:/usr/bin";
const bareMac = { SHELL: "/bin/zsh", PATH: "/usr/bin" };

/** The environment after a Dock launch that started from `start`, with a login shell printing `shell`. */
const afterLaunch = (start: NodeJS.ProcessEnv, shell: Readonly<Record<string, string>>) => {
  const env = { ...start };
  return Effect.as(
    install(env, () => shellPrints(shell)),
    env,
  );
};

it.effect(
  "the login shell's PATH goes first, and SSH agent and Homebrew settings are filled in",
  () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/Users/sam/.local/bin:/usr/bin" };
      const ran: string[] = [];
      yield* install(env, (command) => {
        if (command._tag === "StandardCommand") ran.push(command.command);
        return shellPrints({
          PATH: BREW_PATH,
          SSH_AUTH_SOCK: "/tmp/agent.sock",
          HOMEBREW_PREFIX: "/opt/homebrew",
        });
      });
      assert.deepEqual(ran, ["/bin/zsh"], "one shell, the user's own");
      assert.deepInclude(env, {
        PATH: `${BREW_PATH}:/Users/sam/.local/bin`, // nothing the app had is lost
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        HOMEBREW_PREFIX: "/opt/homebrew",
      });
    }),
);

it.effect("what the app already inherited wins over the shell", () =>
  Effect.map(
    afterLaunch(
      { ...bareMac, SSH_AUTH_SOCK: "/tmp/mine.sock" },
      { PATH: BREW_PATH, SSH_AUTH_SOCK: "/tmp/shell.sock" },
    ),
    (env) => assert.deepInclude(env, { PATH: BREW_PATH, SSH_AUTH_SOCK: "/tmp/mine.sock" }),
  ),
);

describe("the locale", () => {
  const cases: Array<
    [string, NodeJS.ProcessEnv, Record<string, string>, Record<string, string | undefined>]
  > = [
    [
      "comes from the shell when the app has none",
      {},
      { LANG: "fr_FR.UTF-8" },
      { LANG: "fr_FR.UTF-8" },
    ],
    [
      "stays as inherited when the app has one",
      { LANG: "en_GB.UTF-8" },
      { LANG: "fr_FR.UTF-8" },
      { LANG: "en_GB.UTF-8" },
    ],
    [
      "is never a mix of the inherited one and the shell's categories",
      { LANG: "en_GB.UTF-8" },
      { LC_ALL: "fr_FR.UTF-8" },
      { LANG: "en_GB.UTF-8", LC_ALL: undefined },
    ],
    [
      "falls back to UTF-8 text alone when nobody has one",
      {},
      {},
      { LANG: undefined, LC_ALL: undefined, LC_CTYPE: "en_US.UTF-8" },
    ],
  ];
  it.effect.each(cases)("%s", ([, inherited, shell, expected]) =>
    Effect.map(afterLaunch({ ...bareMac, ...inherited }, { PATH: BREW_PATH, ...shell }), (env) => {
      for (const [name, value] of Object.entries(expected)) assert.equal(env[name], value, name);
    }),
  );
});

it.effect("a shell that reports no PATH (nushell, say) falls back to zsh, then launchctl", () =>
  Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = { SHELL: "/opt/homebrew/bin/nu", PATH: "/usr/bin" };
    const tried: string[] = [];
    yield* install(env, (command) => {
      const exe = command._tag === "StandardCommand" ? command.command : "";
      tried.push(exe);
      return exe === "/bin/launchctl" ? BREW_PATH : "";
    });
    assert.deepEqual(tried, ["/opt/homebrew/bin/nu", "/bin/zsh", "/bin/launchctl"]);
    assert.equal(env.PATH, BREW_PATH);
  }),
);

it.effect(
  "a shell that cannot start is logged by name and argument count, never its arguments",
  () => {
    const denied = PlatformError.systemError({
      pathOrDescriptor: "/bin/zsh",
      method: "spawn",
      module: "ChildProcess",
      _tag: "PermissionDenied",
    });
    const parts: unknown[] = [];
    const keep = Logger.make(
      ({ message }) => void parts.push(...(Array.isArray(message) ? message : [message])),
    );
    return Effect.gen(function* () {
      yield* install({ ...bareMac }, () => "", denied);
      const fromLoginShell = parts
        .filter(Schema.is(LoginEnv.LoginEnvCommandError))
        .filter((e) => e.probe === "login-shell");
      assert.lengthOf(fromLoginShell, 1);
      const [error] = fromLoginShell;
      assert.deepInclude(error, { executable: "zsh", argumentCount: 2, cause: denied });
      assert.notProperty(error, "args");
      assert.notInclude(error!.message, denied.message);
    }).pipe(Effect.provide(Logger.layer([keep], { mergeWithExisting: false })));
  },
);
