import * as Schema from "effect/Schema";

import { NonblankString } from "./primitives.ts";
import type { ScmHostKind } from "./scmHosts.ts";

// Only the vocabulary that thread links still carry survives; browsing and
// reviewing pull requests left with the PR panel.

export const MergeRequestState = Schema.Literals(["open", "closed", "merged"]);
export type MergeRequestState = Schema.Schema.Type<typeof MergeRequestState>;

export const MergeRequestReviewDecision = Schema.Literals([
  "approved",
  "changes-requested",
  "review-required",
]);
export type MergeRequestReviewDecision = Schema.Schema.Type<typeof MergeRequestReviewDecision>;

export const MergeRequestChecksState = Schema.Literals(["passing", "failing", "pending"]);
export type MergeRequestChecksState = Schema.Schema.Type<typeof MergeRequestChecksState>;

export const MergeRequestMergeability = Schema.Literals(["mergeable", "conflicting", "unknown"]);
export type MergeRequestMergeability = Schema.Schema.Type<typeof MergeRequestMergeability>;

export const MergeRequestMergeMethod = Schema.Literals(["merge", "squash", "rebase"]);
export type MergeRequestMergeMethod = Schema.Schema.Type<typeof MergeRequestMergeMethod>;

export const MergeRequestActor = Schema.Struct({
  login: NonblankString,
  name: Schema.NullOr(Schema.String),
  // A null avatar makes the UI fall back to initials.
  avatarUrl: Schema.NullOr(Schema.String),
});
export type MergeRequestActor = Schema.Schema.Type<typeof MergeRequestActor>;

/**
 * The bucket a repository's host belongs to, shared by server and page. Forgejo
 * instances can sit on one hostname with different HTTP ports, so for them the
 * remote URL's `host` (port included) wins; every other case uses the canonical
 * key's first segment, and an SSH remote keeps its canonical host.
 */
type RemoteIdentity = Partial<{
  readonly canonicalKey: string | undefined;
  readonly locator: { readonly remoteUrl: string } | undefined;
}>;

/** `host[:port]` of an http(s) remote URL, or null for SSH and anything unparsable. */
const webAuthorityOf = (remoteUrl: string): string | null => {
  if (!URL.canParse(remoteUrl)) return null;
  const { protocol, host } = new URL(remoteUrl);
  const isWeb = protocol === "http:" || protocol === "https:";
  return isWeb && host !== "" ? host.toLowerCase() : null;
};

export function mergeRequestHostOf(
  remote: RemoteIdentity | null | undefined,
  provider: ScmHostKind,
): string {
  const forgejoAuthority =
    provider === "forgejo" && remote?.locator ? webAuthorityOf(remote.locator.remoteUrl) : null;
  if (forgejoAuthority !== null) return forgejoAuthority;
  const [leading = ""] = (remote?.canonicalKey ?? "").split("/");
  return leading.trim().toLowerCase() || provider;
}
