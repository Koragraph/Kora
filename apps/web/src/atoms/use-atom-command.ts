import { useCallback, useContext } from "react";
import {
  runAtomAction,
  type AtomActionResult,
  type AtomActionOptions,
  type AtomCommand,
} from "@kora/client-runtime/store/runtime";
import { RegistryContext } from "@effect/atom-react";

export function useAtomAction<A, E, W>(
  cmd: AtomCommand<W, A, E>,
  opts?: string | AtomActionOptions,
): (val: W) => Promise<AtomActionResult<A, E>> {
  const registry = useContext(RegistryContext);
  const caption = typeof opts === "string" ? opts : (opts?.label ?? cmd.label);
  const reportFailure = typeof opts === "string" ? true : (opts?.reportFailure ?? true);
  const reportDefect = typeof opts === "string" ? true : (opts?.reportDefect ?? true);

  return useCallback(
    (val: W) => runAtomAction(registry, cmd, val, { label: caption, reportFailure, reportDefect }),
    [cmd, caption, registry, reportDefect, reportFailure],
  );
}
