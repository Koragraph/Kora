// @effect-diagnostics nodeBuiltinImport:off -- plain Node APIs: this module is the boundary to the in-process kora runtime, which is not Effect code.
import * as os from "node:os";
import * as path from "node:path";

/** One handler function per RPC method name. Returns an Effect (unary) or Stream (subscribe*). */
export type Handler = (input: unknown) => unknown;

/** A disjoint set of handlers for one domain, merged into the daemon's handler table. */
export type HandlerRecord = Record<string, Handler>;

/** Expand a leading `~` to the home directory (clients send `~/…` verbatim; they can't expand it). */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * JSON-sanitize a value before it reaches the wire. Our wire codec
 * (`RpcSerialization.layerJson`) DIES on any nested `undefined` ("Expected JSON
 * value"), which tears the whole subscription stream. `JSON.stringify` drops
 * undefined keys; we route the round-trip through it and map a throw/undefined to
 * `null`. Use this on any emitted value that might carry an absent optional field.
 */
export function jsonSafe<T>(value: T): T {
  if (value === undefined) return null as unknown as T;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? (null as unknown as T) : (JSON.parse(json) as T);
  } catch {
    return null as unknown as T;
  }
}
