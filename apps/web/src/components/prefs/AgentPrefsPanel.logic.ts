import type { HostLinkPhase } from "@kora/client-runtime/link";

/** Settings › Agents is searchable once the daemon is connected and has sent its config. */
export function isAgentPrefsHostAvailable(input: {
  readonly connectionPhase: HostLinkPhase;
  readonly hasDaemonConfig: boolean;
}): boolean {
  return input.connectionPhase === "connected" && input.hasDaemonConfig;
}
