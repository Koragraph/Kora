import type { HostId } from "@kora/contracts";

export interface PromptPathSearchEntry {
  readonly parentPath?: string;
  readonly kind: "file" | "directory";
  readonly path: string;
}

export interface PromptPathSearchState {
  readonly entries: ReadonlyArray<PromptPathSearchEntry>;
  readonly isPending: boolean;
  readonly error: string | null;
}

export interface PromptPathSearchTarget {
  readonly hostId: HostId | null;
  readonly cwd: string | null;
  readonly query: string | null;
}
