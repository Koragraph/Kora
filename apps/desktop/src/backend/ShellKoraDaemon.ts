// @effect-diagnostics nodeBuiltinImport:off -- reads only the last 16 KB of server.log (a tail read FileSystem has no API for).
// The ONE backend: the kora daemon (`kora server run`), a separate long-lived process that serves the unix socket
// (~/.kora/kora.sock: CLI, hooks, orchestrator workers) and the chat UI API on 127.0.0.1:<port>. The desktop never
// spawns or supervises it: the packaged app makes sure it is running (ShellKoraRuntime → kora-runtime.sh), a
// checkout's scripts/start.sh does the same, and the desktop only probes the port and opens the window once it answers.
import * as NodeFS from "node:fs";
import * as Electron from "electron";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import { waitForHttpReady } from "@kora/shared/waitForHttp";

import * as ShellKoraUiToken from "./ShellKoraUiToken.ts";
import * as ShellWindow from "../window/ShellWindow.ts";
import * as NativeDialog from "../native/NativeDialog.ts";
import * as ShellTracing from "../app/ShellTracing.ts";
import * as ShellSupport from "../app/ShellSupport.ts";
import * as ShellKoraRuntime from "../app/ShellKoraRuntime.ts";
import * as ShellContext from "../app/ShellContext.ts";

/** The daemon's fixed chat-UI port (its config `uiPort`); KORA_PORT overrides it for tests. */
const KORA_DAEMON_PORT = 8797;
const READINESS_PATH = "/.well-known/kora/host";
export const PRIMARY_HOST_LABEL = "Local environment";
/** How long the splash may sit before Kora says what is going on (a cold start is ~10 s). */
const SLOW_START_NOTICE_AFTER = Duration.seconds(30);
/** A port held by another program never fixes itself: say that one early. */
const PORT_TAKEN_NOTICE_AFTER = Duration.seconds(5);
const PORT_TAKEN_PATTERN = /already in use by another program/;

/**
 * Whether the daemon's server.log says, at or after `sinceMs`, that its UI port is held by another program
 * (ui-server's port check; each line starts with an ISO timestamp). Older lines are ignored: a port clash
 * from last week must not explain today's slow start.
 */
export function serverLogSaysPortTaken(logText: string, sinceMs: number): boolean {
  for (const ln of logText.split("\n").reverse()) {
    const when = Date.parse(ln.slice(0, 24));
    if (Number.isNaN(when)) continue;
    if (when < sinceMs) return false;
    if (PORT_TAKEN_PATTERN.test(ln)) return true;
  }
  return false;
}

/** Is there a live process behind <KORA_HOME>/daemon.pid? (signal 0 only checks; nothing is sent.) */
export function daemonPidAlive(pidFile: string): boolean {
  try {
    const pid = Number(NodeFS.readFileSync(pidFile, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 1) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLogTail(fileRef: string, buf = 16_384): string {
  try {
    const fd = NodeFS.openSync(fileRef, "r");
    try {
      const extent = NodeFS.fstatSync(fd).size;
      const len = Math.min(extent, buf);
      const bufr = Buffer.alloc(len);
      NodeFS.readSync(fd, bufr, 0, len, extent - len);
      return bufr.toString("utf8");
    } finally {
      NodeFS.closeSync(fd);
    }
  } catch {
    return "";
  }
}

const { logInfo, logWarning } = ShellTracing.makeScopedLogger("desktop-kora-daemon");

export class ShellKoraDaemonBearerError extends Schema.TaggedError<ShellKoraDaemonBearerError>()(
  "ShellKoraDaemonBearerError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Failed to create the local desktop bearer session.";
  }
}

class DaemonNotReady extends Schema.TaggedError<DaemonNotReady>()("DaemonNotReady", {
  cause: Schema.Defect(),
}) {}

export class ShellKoraDaemon extends Context.Service<
  ShellKoraDaemon,
  {
    readonly httpBaseUrl: URL;
    /** Ensure the daemon (packaged app), then open the main window once its UI port answers. */
    readonly start: Effect.Effect<void>;
    /** Bearer for the renderer's HTTP calls + ws tickets, exchanged for the daemon's UI secret (ShellKoraUiToken). */
    readonly bearerToken: Effect.Effect<string, ShellKoraDaemonBearerError>;
  }
>()("@kora/desktop/backend/ShellKoraDaemon") {}

export function toWebSocketBaseUrl(httpOrigin: URL): string {
  const address = new URL(httpOrigin.href);
  address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
  return address.href;
}

const make = Effect.gen(function* () {
  const envVars = yield* ShellContext.ShellContext;
  const shellWindow = yield* ShellWindow.ShellWindow;
  const httpClient = yield* HttpClient.HttpClient;
  const context1 = yield* Effect.context<ShellContext.ShellContext | NativeDialog.NativeDialog>();
  const nativeDialog = yield* NativeDialog.NativeDialog;
  const port = Option.getOrElse(envVars.configuredBackendPort, () => KORA_DAEMON_PORT);
  const httpOrigin = new URL(`http://127.0.0.1:${port}/`);
  const tokenRef = yield* Ref.make(Option.none<string>());
  const mutex = yield* Semaphore.make(1);

  const probeOnce = waitForHttpReady({
    baseUrl: httpOrigin.href,
    path: READINESS_PATH,
    timeoutMs: 30_000,
    intervalMs: 250,
    makeError: ({ cause }) => new DaemonNotReady({ cause }),
  }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

  const quickProbe = waitForHttpReady({
    baseUrl: httpOrigin.href,
    path: READINESS_PATH,
    timeoutMs: 600,
    intervalMs: 200,
    makeError: ({ cause }) => new DaemonNotReady({ cause }),
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, httpClient),
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

  // The daemon outlives the app, but it can also die under it (a crash, `kora server stop`, a killed process): the
  // window then sat on "reconnecting" until the user quit and reopened Kora, the only thing that started it again.
  // Packaged app only: when the UI port stays silent for two checks in a row (~30 s), run kora-runtime.sh ensure
  // again — it starts a missing daemon and restarts one that is alive but silent (recover_unresponsive in
  // kora-runtime.sh: exact pid from daemon.pid, only when older than two minutes).
  const watchdogProbe = waitForHttpReady({
    baseUrl: httpOrigin.href,
    path: READINESS_PATH,
    timeoutMs: 3_000,
    intervalMs: 500,
    makeError: ({ cause }) => new DaemonNotReady({ cause }),
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, httpClient),
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  const watchdog = Effect.gen(function* () {
    let misses = 0;
    while (true) {
      yield* Effect.sleep(Duration.seconds(15));
      if (yield* watchdogProbe) {
        misses = 0;
        continue;
      }
      misses += 1;
      if (misses < 2) continue;
      yield* logWarning("the kora daemon stopped answering; starting it again", { port });
      yield* ShellKoraRuntime.ensure(port, { quiet: true }).pipe(Effect.provide(context1));
      misses = 0;
      yield* Effect.sleep(Duration.seconds(45));
    }
  }).pipe(Effect.withSpan("shell.koraDaemon.watchdog"));

  const begin = Effect.gen(function* () {
    yield* logInfo("attaching to the kora daemon", { url: httpOrigin.href });
    // Packaged app: sync the bundled runtime and start the daemon if it is down. Runs alongside the probe.
    yield* Effect.forkDetach(ShellKoraRuntime.ensure(port).pipe(Effect.provide(context1)));
    // A cold start (first launch: the runtime is copied to ~/.kora/app and the daemon starts) takes ~10 s with no
    // window at all — long enough to look broken and get clicked again. Show the "Starting Kora…" splash meanwhile;
    // the main window replaces it when it reveals.
    const startedAt = yield* Clock.currentTimeMillis;
    if (!(yield* quickProbe)) yield* shellWindow.showStartupSplash;
    // A daemon process that is alive but silent is being restarted by kora-runtime.sh (recover_unresponsive, ~15 s of
    // checks first): say so, instead of a splash that looks like a plain slow start.
    yield* Effect.forkDetach(
      Effect.gen(function* () {
        yield* Effect.sleep(Duration.seconds(6));
        if (yield* quickProbe) return;
        if (!daemonPidAlive(envVars.path.join(envVars.baseDir, "daemon.pid"))) return;
        yield* logWarning(
          "the kora daemon process is alive but not answering; it is being restarted",
          { port },
        );
        yield* shellWindow.setSplashMessage("Restarting Kora's background service…");
      }),
    );
    const waitForDaemon = probeOnce.pipe(
      Effect.tapError(() => logWarning("kora daemon not answering yet; still waiting", { port })),
      Effect.retry({ while: () => true }),
      Effect.orDie,
    );
    // The splash used to wait forever with no word on why (port held by another program, a daemon that will not
    // start). After SLOW_START_NOTICE_AFTER, say so once in a native dialog; it goes away by itself if the
    // daemon answers meanwhile (the race interrupts this fiber; an open dialog just stays until dismissed).
    // A port held by another program is said after PORT_TAKEN_NOTICE_AFTER; a plain slow start only after
    // SLOW_START_NOTICE_AFTER (a cold start after every update is ~10 s, so a short wait showed it on every launch).
    const slowStartNotice = Effect.gen(function* () {
      yield* Effect.sleep(PORT_TAKEN_NOTICE_AFTER);
      while (true) {
        const serverLog = envVars.path.join(envVars.baseDir, "server.log");
        const portTaken = serverLogSaysPortTaken(readLogTail(serverLog), startedAt - 5_000);
        const waited = (yield* Clock.currentTimeMillis) - startedAt;
        if (!portTaken && waited < Duration.toMillis(SLOW_START_NOTICE_AFTER)) {
          yield* Effect.sleep(Duration.seconds(1));
          continue;
        }
        yield* logWarning("kora daemon still not answering; telling the user", { port, portTaken });
        const { response } = yield* nativeDialog
          .showMessageBox({
            type: "warning",
            message: portTaken
              ? "Another app is using Kora's port"
              : "Kora is taking longer than usual to start",
            detail: portTaken
              ? // oxlint-disable-next-line kora/no-global-process-runtime -- only picks the wording of an error message
                process.platform === "win32"
                ? `Kora's background service needs port ${port} on this computer, and another program already uses it. Quit that program, then open Kora again. (In Command Prompt, netstat -ano | findstr :${port} shows the process id of the program using it.)`
                : `Kora's background service needs port ${port} on this Mac, and another program already uses it. Quit that program, then open Kora again. (In Terminal, lsof -i :${port} shows which program it is.)`
              : "Its background service has not answered yet. This can happen on the first launch after an update. You can keep waiting, or open the log to see what it is doing.",
            buttons: ["Keep Waiting", "Show Log", "Quit Kora"],
            defaultId: 0,
            cancelId: 0,
          })
          .pipe(Effect.orElseSucceed(() => ({ response: 0, checkboxChecked: false })));
        if (response === 2) {
          yield* Effect.sync(() => Electron.app.quit());
          return;
        }
        if (response === 1) yield* ShellSupport.revealLogs.pipe(Effect.provide(context1));
        yield* Effect.sleep(Duration.seconds(60));
      }
    });
    yield* Effect.raceFirst(waitForDaemon, slowStartNotice.pipe(Effect.andThen(Effect.never)));
    yield* shellWindow
      .handleBackendReady(httpOrigin)
      .pipe(Effect.catch((err) => logWarning("opening the main window failed", { error: err })));
    if (Option.isSome(envVars.koraRuntimeScript)) yield* Effect.forkDetach(watchdog);
  }).pipe(Effect.withSpan("shell.koraDaemon.start"));

  const bearerToken = mutex
    .withPermits(1)(
      Effect.gen(function* () {
        const memo = yield* Ref.get(tokenRef);
        if (Option.isSome(memo)) return memo.value;
        // Identity first: the secret goes only to a daemon that proves it holds it (ShellKoraUiToken).
        const sess = yield* ShellKoraUiToken.exchangeVerifiedCredential({
          baseDir: envVars.baseDir,
          httpBaseUrl: httpOrigin.href,
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.tapError((cause) =>
            cause instanceof ShellKoraUiToken.DaemonIdentityError
              ? logWarning("refused to send the UI secret: daemon identity check failed", {
                  port,
                  reason: cause.reason,
                  detail: cause.message,
                })
              : Effect.void,
          ),
          Effect.mapError((cause) => new ShellKoraDaemonBearerError({ cause })),
        );
        yield* Ref.set(tokenRef, Option.some(sess.accessToken));
        return sess.accessToken;
      }),
    )
    .pipe(Effect.withSpan("shell.koraDaemon.bearerToken"));

  return ShellKoraDaemon.of({ httpBaseUrl: httpOrigin, start: begin, bearerToken });
});

export const layer = Layer.effect(ShellKoraDaemon, make);
