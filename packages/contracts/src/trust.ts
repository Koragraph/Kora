import * as Schema from "effect/Schema";

/**
 * Per-folder trust (daemon: `packages/runtime/src/trust/store.ts`). Until the user trusts a folder, Kora's agents
 * run there in restricted mode: the repository's own agent configuration — Claude Code project hooks and MCP servers,
 * Codex project config, OpenCode / Koragent plugins and tools — is not loaded. Trusting a folder covers its
 * subfolders and worktrees. Wire rule: every field required, nullable with `NullOr` (never undefined).
 */
export const TRUST_METHODS = {
  get: "trust.get",
  set: "trust.set",
  list: "trust.list",
} as const;

export const TrustSource = Schema.Literals(["user", "migration", "cli", "kora"]);
export type TrustSource = typeof TrustSource.Type;

export const FolderTrustStatus = Schema.Struct({
  /** The folder asked about. */
  cwd: Schema.String,
  /** What trust is keyed by: the repository root (a worktree's main checkout), else the folder. */
  root: Schema.String,
  trusted: Schema.Boolean,
  /** The stored folder covering it (itself or an ancestor). */
  trustedBy: Schema.NullOr(Schema.String),
  source: Schema.NullOr(TrustSource),
  /** False for a folder that can never be trusted (home, `/`, missing); `reason` says why. */
  canTrust: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
});
export type FolderTrustStatus = typeof FolderTrustStatus.Type;

export const TrustGetInput = Schema.Struct({ cwd: Schema.String });
export type TrustGetInput = typeof TrustGetInput.Type;

export const TrustSetInput = Schema.Struct({
  cwd: Schema.String,
  /** true = trust the folder; false = revoke. */
  trusted: Schema.Boolean,
});
export type TrustSetInput = typeof TrustSetInput.Type;

export const TrustedFolder = Schema.Struct({
  path: Schema.String,
  trustedAt: Schema.Finite,
  source: TrustSource,
});
export type TrustedFolder = typeof TrustedFolder.Type;

export const TrustListResult = Schema.Struct({ folders: Schema.Array(TrustedFolder) });
export type TrustListResult = typeof TrustListResult.Type;

/** Every trust failure. `message` is safe to show. */
export class TrustOperationError extends Schema.TaggedError<TrustOperationError>()(
  "TrustOperationError",
  { operation: Schema.String, message: Schema.String },
) {}
