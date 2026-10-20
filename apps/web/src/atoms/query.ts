import { AsyncResult, Atom } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";

const EMPTY_ASYNC_RESULT_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("web-environment-query:empty"),
);

export interface HostQueryView<A> {
  readonly refresh: () => void;
  readonly isSuccess: boolean;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly data: A | null;
}

function formatHostQueryError(reason: Cause.Cause<unknown>): string {
  const err = Cause.squash(reason);
  return err instanceof Error && err.message.trim().length > 0
    ? err.message
    : "The environment request failed.";
}

export function useHostQuery<A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null,
): HostQueryView<A> {
  const selectedAtom = atom ?? EMPTY_ASYNC_RESULT_ATOM;
  const outcomeVal = useAtomValue(selectedAtom);
  const refresh = useAtomRefresh(selectedAtom);
  return {
    data: Option.getOrNull(AsyncResult.value(outcomeVal)),
    error: outcomeVal._tag === "Failure" ? formatHostQueryError(outcomeVal.cause) : null,
    isPending: atom !== null && outcomeVal.waiting,
    isSuccess: outcomeVal._tag === "Success",
    refresh,
  };
}
