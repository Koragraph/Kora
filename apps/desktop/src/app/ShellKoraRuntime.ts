// @effect-diagnostics nodeBuiltinImport:off -- spawns the detached-daemon launcher script with fd-redirected output.
// The packaged app carries the whole kora runtime (daemon + CLI + hooks + koragraph + a pinned node) in
// Contents/Resources/runtime. On launch it runs Contents/Resources/kora-runtime.sh, which syncs that runtime to the
// stable copy ~/.kora/app (only when the build differs), links ~/.local/bin/kora and starts the daemon when it is
// down. The daemon is deliberately NOT a child of the app and outlives it: the CLI, repo hooks and orchestrator
// workers talk to its socket whether or not a window is open. The desktop then attaches to 127.0.0.1:8797 as before.
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";

import * as ShellTracing from "./ShellTracing.ts";
import * as ShellContext from "./ShellContext.ts";
import * as NativeDialog from "../native/NativeDialog.ts";

const { logInfo, logWarning } = ShellTracing.makeScopedLogger("desktop-kora-runtime");

/** Env for the runtime script: the app's (login-shell-hydrated) env minus anything that would change how node runs. */
function makeKoraRuntimeEnv(
  env: NodeJS.ProcessEnv,
  port: number,
): Record<string, string | undefined> {
  const upcoming: Record<string, string | undefined> = { ...env, KORA_UI_PORT: String(port) };
  for (const keyName of [
    "ELECTRON_RUN_AS_NODE",
    "ELECTRON_NO_ATTACH_CONSOLE",
    "NODE_OPTIONS",
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SSE_PORT",
  ]) {
    delete upcoming[keyName];
  }
  return upcoming;
}

function runScript(script: string, port: number, logFile: string): Promise<number> {
  return new Promise((resolve) => {
    let acc: number | "ignore" = "ignore";
    try {
      NodeFS.mkdirSync(NodePath.dirname(logFile), { recursive: true });
      acc = NodeFS.openSync(logFile, "a");
    } catch {
      acc = "ignore";
    }
    // Windows has no /bin/sh: kora-runtime.cjs runs under the bundled runtime's own node.exe.
    const [command, args] = script.endsWith(".cjs")
      ? [NodePath.join(NodePath.dirname(script), "runtime", "bin", "node.exe"), [script, "ensure"]]
      : // oxlint-disable-next-line kora/no-posix-only-paths -- the .sh launcher is the macOS one; Windows ships kora-runtime.cjs (branch above)
        ["/bin/sh", [script, "ensure"]];
    const kid = NodeChildProcess.spawn(command, args, {
      stdio: ["ignore", acc, acc],
      windowsHide: true,
      env: makeKoraRuntimeEnv(process.env, port),
      cwd: NodePath.dirname(script),
    });
    const done = (code: number) => {
      if (typeof acc === "number") NodeFS.closeSync(acc);
      resolve(code);
    };
    kid.on("error", () => done(127));
    kid.on("exit", (code) => done(code ?? 1));
  });
}

/** The script's last `[kora-runtime …]` line (its `die` reason, e.g. "port 8797 is held by pid …"), or "". */
export function lastRuntimeReason(logFile: string): string {
  try {
    const lines = NodeFS.readFileSync(logFile, "utf8").split("\n");
    return (lines.reverse().find((ln) => ln.startsWith("[kora-runtime ")) ?? "").replace(
      /^\[[^\]]*\]\s*/,
      "",
    );
  } catch {
    return "";
  }
}

/** Sync the bundled runtime and make sure the daemon is up. Never fails: readiness is probed separately. */
export const ensure = Effect.fn("shell.koraRuntime.ensure")(function* (
  port: number,
  opts: { readonly quiet?: boolean } = {},
) {
  const envVars = yield* ShellContext.ShellContext;
  const dialog = yield* NativeDialog.NativeDialog;
  if (Option.isNone(envVars.koraRuntimeScript)) return;
  const script = envVars.koraRuntimeScript.value;
  const logFile = NodePath.join(envVars.baseDir, "app-launch.log");
  yield* logInfo("ensuring the kora runtime and daemon", { script, port });
  const exitCode = yield* Effect.promise(() => runScript(script, port, logFile));
  if (exitCode === 0) {
    yield* logInfo("kora daemon ready", { port });
  } else {
    yield* logWarning("kora-runtime.sh failed; see app-launch.log", { code: exitCode, logFile });
    // The watchdog's restarts stay quiet: one failed launch already said so, and it retries.
    if (opts.quiet) return;
    const why = lastRuntimeReason(logFile);
    yield* dialog.showErrorBox(
      "Kora could not start its background service",
      `The kora daemon did not come up on 127.0.0.1:${port}.${why ? ` ${why.replace(/\.$/, "")}.` : ""} Details: ${logFile} and ${NodePath.join(envVars.baseDir, "server.log")}.`,
    );
  }
});
