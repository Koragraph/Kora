// @effect-diagnostics globalDate:off -- plain timestamps for wire payloads and logs, produced outside any Effect fiber.
// @effect-diagnostics nodeBuiltinImport:off -- plain Node APIs: this module is the boundary to the in-process kora runtime, which is not Effect code.
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  EDITORS,
  WorkspaceGrepError,
  WorkspaceFindError,
  WorkspaceFileWriteError,
  RPC_METHODS,
} from "@kora/contracts";
import * as Effect from "effect/Effect";

import {
  type FindOptions,
  GREP_TIMEOUT_MS,
  type GrepOptions,
  findInWorker,
  grepInWorker,
} from "./grepWorker.ts";
import { type HandlerRecord, expandHome, jsonSafe } from "./shared.ts";
import { winCommand } from "../winSpawn.ts";

/**
 * Domain handlers for the kora daemon. Filled in to replace hanging stubs so
 * every Kora RPC in this domain returns a schema-valid response (real, benign-empty,
 * or a typed error the client handles) instead of `Effect.never`.
 *
 * Real where cheap and safe (git shell-outs for `vcs.*`, filesystem walks for
 * `projects.*`); benign no-ops or typed errors where the backing resource is
 * absent (clone tracker, agent-session scanner, attachment store, cloud relay).
 */

// The file picker walk and the content grep run in worker threads: ./grepWorker.ts.

/**
 * Where `target` (lexically inside `root`) really lands once symlinks resolve, when that is OUTSIDE `root`'s real
 * path; null when it stays inside. The deepest existing ancestor is realpath'd (the rest does not exist yet, so it
 * cannot be a link), and an existing target that is itself a symlink is followed.
 */
export function resolvesOutside(
  root: string,
  target: string,
): { resolved: string; root: string } | null {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return null; // no workspace on disk: the write fails on its own
  }
  let existing = target;
  const rest: string[] = [];
  for (;;) {
    try {
      fs.lstatSync(existing);
      break;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return null;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
  let resolved: string;
  try {
    resolved = path.join(fs.realpathSync(existing), ...rest);
  } catch {
    // A dangling symlink: refuse rather than let the write create its target wherever it points.
    return { resolved: existing, root: realRoot };
  }
  const inside = resolved === realRoot || resolved.startsWith(realRoot + path.sep);
  return inside ? null : { resolved, root: realRoot };
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

export const workspaceHandlers: HandlerRecord = {
  // -- vcs.* (real: shell out to git) --------------------------------------

  // -- projects.* (real: filesystem) ---------------------------------------

  // Fuzzy file/dir listing for the @mention & file picker: substring match over a
  // capped recursive walk (node_modules/.git skipped). The walk (up to 20k entries, once
  // per keystroke) runs in a worker thread, never on the daemon's event loop.
  [RPC_METHODS.filesFind]: (input) => {
    const i = input as FindOptions;
    const fail = (failure: "search_index_scan_timed_out" | "directory_list_failed") =>
      new WorkspaceFindError({
        cwd: i.cwd,
        queryLength: i.query.length,
        limit: i.limit,
        failure,
        ...(failure === "search_index_scan_timed_out"
          ? { timeout: `${GREP_TIMEOUT_MS / 1000}s` }
          : {}),
      } as never);
    return Effect.tryPromise({
      try: (signal) => findInWorker({ ...i, cwd: expandHome(i.cwd) }, { signal }),
      catch: () => fail("directory_list_failed"),
    }).pipe(
      Effect.flatMap((r) =>
        r.timedOut
          ? Effect.fail(fail("search_index_scan_timed_out"))
          : Effect.succeed(jsonSafe({ entries: r.entries, truncated: r.truncated })),
      ),
    );
  },

  // Content grep: scan capped text files under cwd for the query. Regex when
  // requested (literal fallback + `regexFallbackError` on a bad pattern). Runs in a
  // worker thread with a wall-clock budget (a ReDoS pattern or a huge tree must never
  // stall the daemon's event loop); interrupting the RPC terminates the worker.
  [RPC_METHODS.filesGrep]: (input) => {
    const i = input as GrepOptions;
    const cwd = expandHome(i.cwd);
    const fail = (failure: "search_index_scan_timed_out" | "search_index_search_failed") =>
      new WorkspaceGrepError({
        cwd: i.cwd,
        queryLength: i.query.length,
        limit: i.limit,
        failure,
        ...(failure === "search_index_scan_timed_out"
          ? {
              timeout: `${GREP_TIMEOUT_MS / 1000}s`,
              message: `Search took longer than ${GREP_TIMEOUT_MS / 1000}s and was stopped (try a simpler pattern or a narrower folder).`,
            }
          : {}),
      } as never);
    return Effect.tryPromise({
      try: (signal) => grepInWorker({ ...i, cwd }, { signal }),
      catch: () => fail("search_index_search_failed"),
    }).pipe(
      Effect.flatMap((r) =>
        r.timedOut && r.matches.length === 0
          ? Effect.fail(fail("search_index_scan_timed_out"))
          : Effect.succeed(
              jsonSafe({
                matches: r.matches,
                truncated: r.truncated,
                ...(r.regexFallbackError !== undefined
                  ? { regexFallbackError: r.regexFallbackError }
                  : {}),
              }),
            ),
      ),
    );
  },

  // Write a workspace-relative file. Guards against paths escaping the workspace root.
  [RPC_METHODS.filesWrite]: (input) =>
    Effect.suspend(() => {
      const i = input as { cwd: string; relativePath: string; contents: string };
      const root = path.resolve(expandHome(i.cwd));
      const target = path.resolve(root, i.relativePath);
      if (target !== root && !target.startsWith(root + path.sep)) {
        return Effect.fail(
          new WorkspaceFileWriteError({
            cwd: i.cwd,
            relativePath: i.relativePath,
            failure: "workspace_path_outside_root",
            resolvedPath: target,
            resolvedWorkspaceRoot: root,
          }),
        );
      }
      // The lexical check above is not enough: a symlink INSIDE the workspace (a cloned repo can commit one, e.g.
      // `docs -> ~/.ssh`) would carry the write outside it. Resolve what exists of the target on disk.
      const escaped = resolvesOutside(root, target);
      if (escaped !== null) {
        return Effect.fail(
          new WorkspaceFileWriteError({
            cwd: i.cwd,
            relativePath: i.relativePath,
            failure: "resolved_path_outside_root",
            resolvedPath: escaped.resolved,
            resolvedWorkspaceRoot: escaped.root,
          }),
        );
      }
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, i.contents, "utf8");
        return Effect.succeed({ relativePath: i.relativePath });
      } catch (cause) {
        return Effect.fail(
          new WorkspaceFileWriteError({
            cwd: i.cwd,
            relativePath: i.relativePath,
            failure: "operation_failed",
            operation: "write-file",
            resolvedPath: target,
            cause,
          }),
        );
      }
    }),

  // -- projectClone.* (no clone tracker on this daemon) --------------------

  // -- worktreeSetup.cancel (no setup tracker) -----------------------------

  // -- attachments.* (no upload store) -------------------------------------

  // -- shell.openInEditor (best-effort real launch) ------------------------

  // Best effort: spawn the requested editor's CLI (or `open` for the file manager
  // / reveal) detached. Any failure degrades to a benign no-op — there is no
  // success payload, so a hung request is the only real hazard to avoid.
  [RPC_METHODS.editorOpen]: (input) =>
    Effect.suspend(() => {
      const i = input as { cwd: string; editor: string; reveal?: boolean };
      // Always an absolute path: a `cwd` starting with `-` must never reach the editor CLI / `open` as an option.
      const target = path.resolve(expandHome(i.cwd));
      try {
        const def = EDITORS.find((e) => e.id === i.editor);
        const spawnDetached = (command: string, args: ReadonlyArray<string>) => {
          const w = winCommand(command, args); // Windows: `code` is code.cmd (PATHEXT + cmd.exe)
          const child = cp.spawn(w.command, w.args, {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
            windowsVerbatimArguments: w.windowsVerbatimArguments,
          });
          child.on("error", () => {});
          child.unref();
        };
        if (!def || def.commands === null || i.reveal) {
          // File-manager reveal / no CLI: fall back to the OS opener where available.
          if (process.platform === "darwin") {
            spawnDetached("open", i.reveal ? ["-R", target] : [target]);
          } else if (process.platform === "win32") {
            spawnDetached("explorer", [target]);
          } else {
            spawnDetached("xdg-open", [target]);
          }
        } else {
          const baseArgs = "baseArgs" in def && def.baseArgs ? def.baseArgs : [];
          spawnDetached(def.commands[0], [...baseArgs, target]);
        }
      } catch {
        // ignore — benign no-op
      }
      return Effect.void;
    }),
};
