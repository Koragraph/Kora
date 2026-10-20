// The Outside access page's client API (blobs.outside.*, see packages/runtime/src/blobs/outside/WIRING.md). Components
// receive it as a value (a context), so tests and the scratch renderer pass a fake; the app mounts the RPC-backed one.
import { createContext, createElement, useContext, type ReactNode } from "react";

export type OutsideResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

export interface OutsideTokenWire {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly revokedAt: number | null;
  /** Last four characters of the token, to tell two apart. The token itself is never stored. */
  readonly suffix: string;
}

export interface OutsideAuditWire {
  readonly id: string;
  readonly at: number;
  readonly tokenId: string;
  readonly client: string;
  readonly tool: string;
  readonly target: string | null;
  readonly ok: boolean;
  readonly note: string | null;
}

/** How an outside client launches the bridge on THIS install (the stable app and Kora Dev differ). */
export interface OutsideSetupWire {
  /** Absolute path of the CLI shim, for configs that have no PATH. */
  readonly command: string;
  /** Always starts `mcp --team`; Kora Dev adds its socket. */
  readonly args: ReadonlyArray<string>;
  /** Name for the server entry: "kora-team" (stable) or "kora-dev-team". */
  readonly serverName: string;
  readonly limits: { readonly callsPerMinute: number; readonly sendsPerMinute: number };
}

export interface OutsideApi {
  setup: () => Promise<OutsideResult<OutsideSetupWire>>;
  tokens: () => Promise<OutsideResult<ReadonlyArray<OutsideTokenWire>>>;
  /** The plaintext token comes back on this call only. */
  create: (name: string) => Promise<OutsideResult<{ token: OutsideTokenWire; secret: string }>>;
  revoke: (id: string) => Promise<OutsideResult<true>>;
  /** Newest first; `before` is the previous page's `next`. */
  audit: (
    before: number | null,
  ) => Promise<OutsideResult<{ rows: ReadonlyArray<OutsideAuditWire>; next: number | null }>>;
}

const unavailable = async (): Promise<OutsideResult<never>> => ({
  ok: false,
  message: "Outside access is not connected yet.",
});

const UNAVAILABLE_OUTSIDE_API: OutsideApi = {
  setup: unavailable,
  tokens: unavailable,
  create: unavailable,
  revoke: unavailable,
  audit: unavailable,
};

const Ctx = createContext<OutsideApi>(UNAVAILABLE_OUTSIDE_API);

export function OutsideApiProvider(props: {
  readonly api: OutsideApi;
  readonly children: ReactNode;
}) {
  return createElement(Ctx.Provider, { value: props.api }, props.children);
}

export function useOutsideApi(): OutsideApi {
  return useContext(Ctx);
}
