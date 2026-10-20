import type {
  ThreadLinkedMergeRequest,
  ThreadMergeRequestKey,
  ThreadMergeRequestLink,
} from "@kora/contracts";

import { parseChangeRequestUrl } from "./mergeRequestUrl.ts";
import { canonicalRepositoryKey } from "./changeRequestTerms.ts";

interface KeyLike extends ThreadMergeRequestKey {
  readonly authority?: string | undefined;
  readonly url?: string | undefined;
}

interface NormalizedKey {
  readonly host: string;
  readonly repository: string;
}

// This module runs in the home thread list on every launch, including on Hermes, which lacks
// the ES2023 copy methods (toSorted and friends): no array-copy sugar here.

const normalizeKey = (key: KeyLike): NormalizedKey => {
  const repository = key.repository.trim().toLowerCase();
  let authority = key.authority?.trim().toLowerCase();
  if (authority === undefined && key.url !== undefined) {
    // Old stored links lost the Forgejo HTTP port; the URL still has it.
    const parsed = parseChangeRequestUrl(key.url);
    if (
      parsed !== null &&
      parsed.repository.trim().toLowerCase() === repository &&
      parsed.number === key.number &&
      parsed.authority !== undefined
    ) {
      authority = parsed.authority.trim().toLowerCase();
    }
  }
  const canonical = canonicalRepositoryKey(
    `${authority ?? key.host.trim().toLowerCase()}/${repository}`,
  );
  const slash = canonical.indexOf("/");
  return slash === -1
    ? { host: canonical, repository: "" }
    : { host: canonical.slice(0, slash), repository: canonical.slice(slash + 1) };
};

const repositoryKey = (key: KeyLike): string => {
  const normalized = normalizeKey(key);
  return `${normalized.host}/${normalized.repository}`;
};

const identity = (key: KeyLike): string => `${repositoryKey(key)}#${key.number}`;

export function threadMergeRequestKeysEqual(left: KeyLike, right: KeyLike): boolean {
  return identity(left) === identity(right);
}

/** Dismissed stack members stay in storage as tombstones (so the sync does not re-add them) but are not shown. */
const visibleLinks = (links: ReadonlyArray<ThreadMergeRequestLink>) =>
  links.filter((link) => link.source !== "stack-dismissed");

type SearchableThread = {
  readonly linkedPullRequest?: ThreadLinkedMergeRequest | null | undefined;
  readonly pullRequests?: ReadonlyArray<ThreadMergeRequestLink> | undefined;
};

const refTerms = (ref: { number: number; repository: string; url: string }) => [
  `#${ref.number}`,
  `${ref.repository}#${ref.number}`,
  ref.url,
];

export function threadMergeRequestSearchTerms(thread: SearchableThread): string[] {
  const links = thread.pullRequests ?? [];
  // Old environments decode to an empty list and still carry the single legacy link.
  if (links.length === 0) {
    return thread.linkedPullRequest ? refTerms(thread.linkedPullRequest) : [];
  }
  return visibleLinks(links).flatMap((link) => [...refTerms(link), link.snapshot?.title ?? ""]);
}
