// @effect-diagnostics nodeBuiltinImport:off -- plain path resolution shared by every module that touches disk.
// The ui-server's one resolver for the daemon's on-disk roots, the same resolution as the runtime's
// `koraHome()` (packages/runtime/src/protocol/types.ts) and the engine's store path (koragraph src/db/pool.js).
// A flavored install (Kora Dev: ~/.kora-dev, its own graph store) only works if nothing hard-codes ~/.kora or
// ~/.koragraph, so resolve them here and nowhere else. Map of everything under them: docs/ARCHITECTURE.md.
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

/** `KORA_HOME`, else `~/.kora`. */
export function koraHome(): string {
  return process.env.KORA_HOME || NodePath.join(NodeOs.homedir(), ".kora");
}

/** The graph engine's home (locks, catch-up.log): `KORAGRAPH_HOME`, else `~/.koragraph`. */
export function koragraphHome(): string {
  return process.env.KORAGRAPH_HOME || NodePath.join(NodeOs.homedir(), ".koragraph");
}

/** The graph store: `KORAGRAPH_DB`, else `<koragraphHome>/graph.db`. */
export function graphDbPath(): string {
  return process.env.KORAGRAPH_DB || NodePath.join(koragraphHome(), "graph.db");
}
