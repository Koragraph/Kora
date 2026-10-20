import type { HostThreadStatus } from "@kora/client-runtime/store/threads";

export type ThreadLoadPhase = "loading" | "syncing";

export function resolveThreadLoadPhase(args: {
  readonly detailExists: boolean;
  readonly shellExists: boolean;
  readonly status: HostThreadStatus;
}): ThreadLoadPhase | null {
  if (!args.shellExists) {
    return null;
  }

  switch (args.status) {
    case "live":
    case "deleted":
      return null;
    case "synchronizing":
    case "cached":
    case "empty":
      return args.detailExists ? "syncing" : "loading";
  }
}

export function threadLoadLabel(phase: ThreadLoadPhase): string {
  if (phase === "loading") return "Loading messages...";
  return "Syncing messages...";
}
