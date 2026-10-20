// @effect-diagnostics globalConsole:off -- the daemon logs to stdout for `vp run` / the desktop wrapper, not through a Logger.
// @effect-diagnostics globalDate:off -- plain timestamps for wire payloads and logs, produced outside any Effect fiber.
// @effect-diagnostics nodeBuiltinImport:off -- plain Node APIs: this module is the boundary to the in-process kora runtime, which is not Effect code.
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

import type { ClientChatCommand, DaemonPrefsPatch } from "@kora/contracts";
import {
  BLOB_METHODS,
  KoraRpcGroup,
  RPC_METHODS,
  WorkspaceFileReadError,
  WorkspaceListError,
  ChatDispatchError,
  CHAT_METHODS,
  HostFsBrowseError,
  DaemonPrefsError,
} from "@kora/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as RpcSchema from "effect/unstable/rpc/RpcSchema";

import { hostDescriptor, daemonConfig } from "./config.ts";
import { onAgentStatusesChanged, onAgentsChanged, agentStatusesFrame } from "./modelRefresh.ts";
import { blobsHandlers } from "./handlers/blobs.ts";
import { blobsAppsHandlers } from "./handlers/blobsApps.ts";
import { enginesHandlers } from "./handlers/engines.ts";
import { blobsRoutinesHandlers } from "./handlers/blobsRoutines.ts";
import { blobsGroupsHandlers } from "./handlers/blobsGroups.ts";
import { blobsOutsideHandlers } from "./handlers/blobsOutside.ts";
import { fleetHandlers } from "./handlers/fleet.ts";
import type { Handler } from "./handlers/shared.ts";
import { koraComingSoonError, koraSurfaceOn } from "./koraSurface.ts";
import { swarmHandlers } from "./handlers/swarm.ts";
import { trustHandlers } from "./handlers/trust.ts";
import { extensionsHandlers } from "./handlers/extensions.ts";
import { webHandlers } from "./handlers/preview.ts";
import { workspaceHandlers } from "./handlers/workspace.ts";
import { chatEngine } from "./kora-chat.ts";
import { onPrefsChanged, settingsPath, prefsUpdatedFrame, updateSettings } from "./prefsStore.ts";

/** getArchivedShellSnapshot before the chat engine is up: a benign empty list (a defect here tears the socket). */
function emptyArchivedSnapshot() {
  return { seq: 0, projects: [], threads: [], updatedAt: new Date().toISOString() };
}

/** Expand a leading `~` to the home directory (the client can't, so it sends `~/…` verbatim). */
function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * The first `max` bytes of a REGULAR file and its full size. `readFileSync` on the whole path read a multi-GB log
 * into the daemon's heap, and on `/dev/zero` (or a FIFO) never returned — the daemon's event loop, and with it every
 * websocket, was gone. The file is opened non-blocking (a FIFO cannot hang the open), checked with fstat on the SAME
 * descriptor (no swap between check and read), and read at most `max` bytes.
 */
export function readHead(
  abs: string,
  max: number,
): { slice: Buffer; byteLength: number; regular: boolean } {
  const fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { slice: Buffer.alloc(0), byteLength: 0, regular: false };
    const buf = Buffer.alloc(Math.min(st.size, max));
    let read = 0;
    while (read < buf.length) {
      const n = fs.readSync(fd, buf, read, buf.length - read, read);
      if (n === 0) break;
      read += n;
    }
    return { slice: buf.subarray(0, read), byteLength: st.size, regular: true };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Keep a subscription open forever after emitting its seed frames. A `subscribe*`
 * handler must NEVER return a failed/empty-completing stream: the Kora client tears
 * the whole connection down on an unexpected stream exit (blueprint risk 2), so
 * we concat the seed with `Stream.never` to hold the stream open.
 */
const openAfter = (...items: ReadonlyArray<unknown>): Stream.Stream<unknown> =>
  Stream.concat(Stream.fromIterable(items), Stream.never);

/**
 * The handlers that must be real for the empty Kora shell to render past its
 * "connecting" gate, plus the Wave 2 chat-turn handlers
 * (`chat.dispatch` / `.subscribeThread` / `.subscribeShell`)
 * backed by the in-process kora `SessionManager`. Everything else is
 * auto-stubbed (see `buildHandlers`).
 */
const realHandlers: Record<string, Handler> = {
  // Emit exactly one DaemonConfig snapshot, then hold the stream open. Because
  // `capabilities.connectionProbe` is true the client skips `server.getConfig`.
  // Every settings change then follows as a `settingsUpdated` frame — the only way the
  // client learns a server setting moved (a Settings control stays put without it).
  [RPC_METHODS.subscribeDaemonConfig]: () =>
    Stream.callback<unknown>((queue) =>
      Effect.gen(function* () {
        Queue.offerUnsafe(queue, { version: 1, type: "snapshot", config: daemonConfig });
        const off = onPrefsChanged((settings) =>
          Queue.offerUnsafe(queue, prefsUpdatedFrame(settings)),
        );
        const offAgents = onAgentsChanged((providers) =>
          Queue.offerUnsafe(queue, agentStatusesFrame(providers)),
        );
        // Usage limits (Settings → Usage, the composer's usage line) ride the same frame.
        const offStatuses = onAgentStatusesChanged((providers) =>
          Queue.offerUnsafe(queue, agentStatusesFrame(providers)),
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            off();
            offAgents();
            offStatuses();
          }),
        );
        return yield* Effect.never;
      }),
    ),

  // Implemented even though `connectionProbe:true` makes it optional.
  [RPC_METHODS.daemonConfigGet]: () => Effect.succeed(daemonConfig),

  [RPC_METHODS.daemonProbe]: () => Effect.succeed({}),

  [RPC_METHODS.daemonPrefsUpdate]: (input) =>
    Effect.try({
      try: () => updateSettings((input as { patch: DaemonPrefsPatch }).patch),
      catch: (cause) =>
        new DaemonPrefsError({ settingsPath: settingsPath(), operation: "write-file", cause }),
    }),

  // Real file read (the composer's file-preview / @mention path fires this on open). Reads
  // `cwd`/`relativePath` from disk; a stub here (Effect.never) leaves the request pending forever,
  // which is what surfaced the "Some requests are slow" banner. Cap + binary-guard so a huge or
  // non-text file returns a bounded, valid result instead of blowing the wire.
  [RPC_METHODS.filesRead]: (input) => {
    const i = input as { cwd: string; relativePath: string };
    return Effect.suspend(() => {
      try {
        const abs = path.isAbsolute(i.relativePath)
          ? i.relativePath
          : path.join(i.cwd, i.relativePath);
        const MAX = 512 * 1024;
        const { slice, byteLength, regular } = readHead(abs, MAX);
        if (!regular) {
          return Effect.fail(
            new WorkspaceFileReadError({
              cwd: i.cwd,
              relativePath: i.relativePath,
              failure: "path_not_file",
            }),
          );
        }
        const truncated = byteLength > MAX;
        if (slice.includes(0)) {
          return Effect.fail(
            new WorkspaceFileReadError({
              cwd: i.cwd,
              relativePath: i.relativePath,
              failure: "binary_file",
            }),
          );
        }
        return Effect.succeed({
          relativePath: i.relativePath,
          contents: slice.toString("utf8"),
          byteLength,
          truncated,
        });
      } catch (cause) {
        return Effect.fail(
          new WorkspaceFileReadError({
            cwd: i.cwd,
            relativePath: i.relativePath,
            failure: "operation_failed",
            cause,
          }),
        );
      }
    });
  },

  // Folder browser behind the composer's "Add project" / open-local-folder flow. The client
  // sends the directory it's viewing as `partialPath` (with `~` since it can't expand the home
  // dir itself) plus an optional project `cwd` for relative paths; we list that directory's
  // immediate SUBDIRECTORIES (the entry shape carries no file/dir kind — this is folder
  // navigation, so files are omitted) as { name, fullPath }. A stub here left the picker
  // spinning forever, which is why the button appeared dead. Read-only.
  [RPC_METHODS.fsBrowse]: (input) => {
    const i = input as { partialPath: string; cwd?: string };
    return Effect.suspend(() => {
      try {
        const base = i.cwd ? expandHome(i.cwd) : os.homedir();
        const target = path.resolve(base, expandHome(i.partialPath));
        const dirents = fs.readdirSync(target, { withFileTypes: true });
        const entries = dirents
          .filter((d) => {
            if (d.isDirectory()) return true;
            // Follow a symlink only when it resolves to a directory.
            if (d.isSymbolicLink()) {
              try {
                return fs.statSync(path.join(target, d.name)).isDirectory();
              } catch {
                return false;
              }
            }
            return false;
          })
          .map((d) => ({ name: d.name, fullPath: path.join(target, d.name) }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return Effect.succeed({ parentPath: target, entries });
      } catch (cause) {
        return Effect.fail(
          new HostFsBrowseError({
            partialPath: i.partialPath,
            ...(i.cwd !== undefined ? { cwd: i.cwd } : {}),
            failure: "read_directory_failed",
            cause,
          }),
        );
      }
    });
  },

  // The in-project file tree (also the @mention file picker). `directoryPath` is the folder to
  // list, relative to the project `cwd` (empty = the project root); each returned entry's `path`
  // is relative to `cwd` too, because the client filters children by matching the parent segment
  // (see useDirectoryEntries). Directories and files are both returned (the entry carries a
  // `kind`). Stubbed before, so the tree hung; read-only now.
  [RPC_METHODS.filesList]: (input) => {
    const i = input as { cwd: string; directoryPath?: string };
    return Effect.suspend(() => {
      try {
        const dp = i.directoryPath ?? "";
        const target =
          dp === "" ? expandHome(i.cwd) : path.resolve(expandHome(i.cwd), expandHome(dp));
        const dirents = fs.readdirSync(target, { withFileTypes: true });
        const entries = dirents
          .map((d) => ({
            path: dp === "" ? d.name : `${dp}/${d.name}`,
            kind: d.isDirectory() ? ("directory" as const) : ("file" as const),
            ...(d.name.startsWith(".") ? { ignored: true } : {}),
          }))
          .sort((a, b) => a.path.localeCompare(b.path));
        return Effect.succeed({ entries, truncated: false });
      } catch (cause) {
        return Effect.fail(
          new WorkspaceListError({ cwd: i.cwd, failure: "workspace_root_not_found", cause }),
        );
      }
    });
  },

  // The client's FirstRunGate hard-requires a "welcome" event before it will ever
  // leave the "Still connecting" screen on a fresh install (no persisted
  // projects/threads yet) — see isFirstRunWorkspaceProvenanceAuthoritative in
  // apps/web/src/onboarding/firstRun.logic.ts. Emit it once, then hold the
  // stream open so the subscription never sees an unexpected completion.
  [RPC_METHODS.subscribeDaemonLifecycle]: () =>
    openAfter({
      version: 1,
      sequence: 0,
      type: "welcome",
      payload: {
        environment: hostDescriptor,
        cwd: daemonConfig.cwd,
        projectName: path.basename(daemonConfig.cwd) || "workspace",
      },
    }),

  // The live shell: created projects/threads appear here (snapshot + synchronized,
  // then thread-upserted/project-upserted as commands land) so the UI has a thread
  // to open. Backed by the in-process chat engine.
  [CHAT_METHODS.subscribeThreads]: () => chatEngine().subscribeShell(),

  // A real chat turn: decode the client command, drive the kora SessionManager,
  // return the per-thread sequence cursor. `bootstrap` can create-thread+start in one shot.
  [CHAT_METHODS.dispatch]: (input) =>
    Effect.tryPromise({
      try: () => chatEngine().dispatch(input as ClientChatCommand),
      catch: (cause) =>
        new ChatDispatchError({
          // The engine's own reason ("There is no folder at …") is what the user reads in the toast.
          message:
            cause instanceof Error && cause.message
              ? cause.message
              : "Failed to dispatch chat command",
          cause,
        }),
    }).pipe(Effect.map((sequence) => ({ sequence }))),

  // Hydrated thread detail snapshot, then the live ThreadEvent stream for the turn.
  [CHAT_METHODS.subscribeThread]: (input) =>
    chatEngine().subscribeThread((input as { threadId: string }).threadId),

  // Reads the desktop fires automatically once a thread exists. These MUST return a real
  // (benign, empty) value: a defect here tore down the whole WS connection (see the unary
  // stub note below), which is what made the desktop flap ~1/sec with ≥1 thread present.
  // Archived threads come from the chat engine; search/diff keep no state here, so empty results are correct.
  [CHAT_METHODS.listArchivedThreads]: () =>
    Effect.sync(() => {
      try {
        return chatEngine().archivedShellSnapshot();
      } catch {
        return emptyArchivedSnapshot();
      }
    }),
};

/** True when this RPC streams (its success schema is an `RpcSchema.Stream`). */
const isStreamRpc = (rpc: { readonly successSchema: unknown }): boolean =>
  RpcSchema.isStreamSchema(rpc.successSchema as never);

/**
 * Build the full 140-key handler record `KoraRpcGroup.toLayer` requires by
 * iterating the group's requests (the accessor is `.requests`, a
 * `ReadonlyMap<methodName, Rpc>` on effect@4.0.0-rc.112 — verified against the
 * installed RpcGroup API). Any method without a real handler is stubbed:
 * streaming methods return an empty, never-completing stream; unary methods
 * return an EMPTY, never-completing effect (`Effect.never`), NOT a defect.
 *
 * A defect (`Effect.die`) here crashes the per-connection RpcServer fiber and
 * closes the whole WebSocket — so a single stubbed unary the client fires (e.g.
 * `getArchivedShellSnapshot` once a thread exists) made the desktop reconnect
 * ~1/sec ("Environment unavailable"). Most methods declare an empty error
 * channel, so they cannot fail with a typed error either; `Effect.never` leaves
 * that one request pending (the client query just stays loading) while every
 * other request and subscription on the connection keeps working. Boot-critical
 * and auto-fired reads are implemented for real above so nothing hangs on boot.
 */
/**
 * Merge the per-domain handler records (filesystem/projects/vcs/pull-requests/server/
 * terminal/preview/device/streams/fleet/swarm). `realHandlers` (the boot-critical + chat core) is
 * spread LAST so it wins over any accidental overlap with a domain file.
 */
/**
 * Kora is coming soon (koraSurface.ts): every Kora RPC (all of them are `blobs.*`, error `BlobsRpcError`) fails with a
 * typed "Kora is coming soon" instead of touching the blob runtime. The roster stream stays: its gated snapshot is how
 * the client learns the switch. Decided per call, so a test (or a daemon with the override) gets the real handler.
 */
export function gateKoraHandlers(record: Record<string, Handler>): Record<string, Handler> {
  const out: Record<string, Handler> = {};
  for (const [tag, real] of Object.entries(record)) {
    if (!tag.startsWith("blobs.") || tag === BLOB_METHODS.subscribe) {
      out[tag] = real;
      continue;
    }
    const rpc = KoraRpcGroup.requests.get(tag);
    const stream = rpc !== undefined && isStreamRpc(rpc);
    out[tag] = (input) => {
      if (koraSurfaceOn()) return real(input);
      return stream ? Stream.fail(koraComingSoonError(tag)) : Effect.fail(koraComingSoonError(tag));
    };
  }
  return out;
}

function mergedHandlers(): Record<string, Handler> {
  return {
    ...webHandlers,
    ...workspaceHandlers,
    // Pane-backed terminals + the fleet (must come AFTER terminalPreview/streams, whose terminal
    // entries are the old benign-empty stubs).
    ...fleetHandlers,
    ...swarmHandlers,
    ...trustHandlers,
    ...extensionsHandlers,
    ...gateKoraHandlers({
      ...blobsHandlers,
      ...blobsRoutinesHandlers,
      ...blobsAppsHandlers,
      ...blobsGroupsHandlers,
      ...blobsOutsideHandlers,
    }),
    ...enginesHandlers,
    ...realHandlers,
  };
}

/** The RPC tags that have a REAL handler (everything else in `KoraRpcGroup` is auto-stubbed and hangs). */
export function mergedHandlerTags(): ReadonlySet<string> {
  return new Set(Object.keys(mergedHandlers()));
}

export function buildHandlers(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const merged = mergedHandlers();
  let streamStubs = 0;
  let unaryStubs = 0;
  for (const [tag, rpc] of KoraRpcGroup.requests) {
    const real = merged[tag];
    if (real !== undefined) {
      handlers[tag] = real;
      continue;
    }
    if (isStreamRpc(rpc)) {
      handlers[tag] = () => Stream.never;
      streamStubs += 1;
    } else {
      // Never a defect — see the doc comment above. Hang instead of crashing the connection.
      handlers[tag] = () => Effect.never;
      unaryStubs += 1;
    }
  }
  console.log(
    `[kora-ui] handlers ready: ${Object.keys(merged).length} real, ` +
      `${streamStubs} stream stubs, ${unaryStubs} unary stubs (${KoraRpcGroup.requests.size} total)`,
  );
  return handlers;
}
