// @effect-diagnostics nodeBuiltinImport:off -- runs before any Effect layer exists (first import of main.ts).
// A packaged app can be a second FLAVOR of Kora — "Kora Dev", built from the dev worktree (scripts/package-app.sh
// --flavor dev) — that runs beside the stable Kora.app with nothing shared: its own KORA_HOME (~/.kora-dev), UI port,
// graph store, CLI name and Electron user-data dir. The bundle says so in Contents/Resources/flavor.env (also sourced
// by kora-runtime.sh); this module turns it into the env every later reader (ShellConfig, the runtime script and
// through it the daemon) already honours. Stable bundles and checkouts have no flavor.env: nothing changes.
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFS from "node:fs";

export interface ShellFlavorFile {
  readonly KORA_APP_FLAVOR?: string;
  readonly KORA_APP_NAME?: string;
  readonly KORA_HOME_NAME?: string;
  readonly KORA_PORT?: string;
  readonly KORA_CLI_NAME?: string;
}

/** `KEY=value` / `KEY="value"` lines (the POSIX-sh subset kora-runtime.sh sources). */
export function parseFlavorEnv(str: string): ShellFlavorFile {
  const acc: Record<string, string> = {};
  for (const ln of str.split("\n")) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(ln);
    if (!match) continue;
    acc[match[1]!] = match[2]!.trim().replace(/^"(.*)"$/, "$1");
  }
  return acc;
}

/**
 * The env a flavor implies. The flavor always wins over an inherited KORA_HOME / KORA_PORT: a Kora Dev launched from
 * a shell inside a stable-Kora agent session must never attach to (or restart) the stable daemon.
 */
export function flavorEnv(flavor: ShellFlavorFile, homeDirectory: string): Record<string, string> {
  if (!flavor.KORA_APP_FLAVOR) return {};
  const home = NodePath.join(homeDirectory, flavor.KORA_HOME_NAME || ".kora");
  const port = flavor.KORA_PORT || "8797";
  return {
    KORA_APP_FLAVOR: flavor.KORA_APP_FLAVOR,
    KORA_APP_NAME: flavor.KORA_APP_NAME || "Kora",
    KORA_HOME: home,
    KORA_SOCKET_PATH: NodePath.join(home, "kora.sock"),
    KORA_PORT: port,
    KORA_UI_PORT: port,
    KORA_CLI_NAME: flavor.KORA_CLI_NAME || "kora",
    KORAGRAPH_HOME: NodePath.join(home, "koragraph"),
    KORAGRAPH_DB: NodePath.join(home, "koragraph", "graph.db"),
    KORAGRAPH_PRACTICE_DB: NodePath.join(home, "koragraph", "practice.db"),
  };
}

function applyShellFlavor(resourcesPath: string | undefined, env: NodeJS.ProcessEnv): void {
  if (!resourcesPath) return;
  let str: string;
  try {
    str = NodeFS.readFileSync(NodePath.join(resourcesPath, "flavor.env"), "utf8");
  } catch {
    return;
  }
  const upcoming = flavorEnv(parseFlavorEnv(str), NodeOS.homedir());
  if (Object.keys(upcoming).length === 0) return;
  for (const keyName of ["KORA_ENV", "KORA_PANE_ID", "KORA_CALLER_KEY", "KORA_BIN"])
    delete env[keyName];
  Object.assign(env, upcoming);
}

applyShellFlavor(process.resourcesPath, process.env);
