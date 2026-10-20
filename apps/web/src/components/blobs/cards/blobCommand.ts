import { usePrimaryHostId } from "~/atoms/hosts";
// Promise-returning wrappers over host RPC commands for the transcript cards and the Memory tab. Components await
// these and show the message on failure; they never touch atoms or throw.
import type { HostId } from "@kora/contracts";
import {
  isAtomActionInterrupted,
  type AtomActionResult,
  squashAtomActionFailure,
} from "@kora/client-runtime/store/runtime";
import { useCallback } from "react";

export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

export const COMMAND_OPTIONS = { reportFailure: false } as const;

export function settleCommand<A, E>(
  result: AtomActionResult<A, E>,
  fallback: string,
): ApiResult<A> {
  if (result._tag === "Success") return { ok: true, value: result.value };
  if (isAtomActionInterrupted(result)) return { ok: false, message: "Cancelled." };
  const failure = squashAtomActionFailure(result);
  const message =
    failure instanceof Error && failure.message.trim().length > 0 ? failure.message : fallback;
  return { ok: false, message };
}

const NOT_CONNECTED: ApiResult<never> = { ok: false, message: "Kora is not connected." };

/** `run(fallback, fn)` calls `fn` with the primary host id; a missing host or a thrown error becomes a result. */
export function useBlobRun(): {
  readonly hostId: HostId | null;
  readonly run: <A>(
    fallback: string,
    fn: (hostId: HostId) => Promise<AtomActionResult<A, unknown>>,
  ) => Promise<ApiResult<A>>;
} {
  const hostId = usePrimaryHostId();
  const run = useCallback(
    async <A>(
      fallback: string,
      fn: (hostId: HostId) => Promise<AtomActionResult<A, unknown>>,
    ): Promise<ApiResult<A>> => {
      if (hostId === null) return NOT_CONNECTED;
      try {
        return settleCommand(await fn(hostId), fallback);
      } catch {
        return { ok: false, message: fallback };
      }
    },
    [hostId],
  );
  return { hostId, run };
}
