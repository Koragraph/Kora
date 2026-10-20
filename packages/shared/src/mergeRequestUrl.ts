/**
 * A change request named the way a thread link names one: the host below which the repository
 * is addressed, the repository path as that host writes it, and the number.
 *
 * The two strings are what `mergeRequestHostOf` and the project's `repositoryIdentity` produce
 * from a git remote — lower case, no port, the full path below the host — because links are
 * matched against those. Anything else matches nothing.
 */
export interface ChangeRequestLink {
  readonly number: number;
  readonly repository: string;
  /** Forgejo's HTTP host and port, separate from the portless repository identity. */
  readonly authority?: string;
  readonly host: string;
}

/** The host itself, one of its subdomains, or an install named after the provider. */
function isHostOf(hostname: string, apex: string, label?: string): boolean {
  const direct = hostname === apex || hostname.endsWith("." + apex);
  return direct || (label !== undefined && hostname.split(".").includes(label));
}

/**
 * The repository and number behind a change request URL on a host this can read, or null for
 * anything else — an issue, a commit, a repository root, a host this cannot tell apart from an
 * ordinary link. A doubtful match is worse than no match, so nothing here guesses.
 *
 * Each host is recognised by the path shape it alone uses, guarded by a hostname it could
 * plausibly be served from, since self-hosted installs are named whatever their admin chose:
 * GitLab's `/-/` marker is unique enough to trust on any hostname, while `/pull/` is generic
 * enough that it is only believed from a GitHub-ish host.
 *
 * Nothing here tries to tell a lookalike hostname from a real one — `github.com.evil.test` and
 * the rest are an open set, and blocking spellings of it costs real hosts (`gitlab.com.br` is a
 * registrable domain). What a claim is worth is decided where it is used.
 */
const GITHUB_PULL = /^\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/|$)/u;
const FORGEJO_PULL = /^\/([^/]+(?:\/[^/]+)+)\/pulls\/(\d+)(?:\/|$)/u;
const GITLAB_MERGE_REQUEST = /^\/([^/]+(?:\/[^/]+)+)\/-\/merge_requests\/(\d+)(?:\/|$)/u;
const BITBUCKET_PULL = /^\/([^/]+\/[^/]+)\/pull-requests\/(\d+)(?:\/|$)/u;
const AZURE_PULL = /^\/((?:[^/]+\/)*_git\/[^/]+)\/pullrequest\/(\d+)(?:\/|$)/u;

export function parseChangeRequestUrl(targetUrl: string): ChangeRequestLink | null {
  const url = URL.canParse(targetUrl) ? new URL(targetUrl) : null;
  // `javascript:`, `mailto:` and friends have no host to speak of and nothing to open.
  if (url === null || !/^https?:$/.test(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname;

  // GitHub, and any Enterprise install: /{owner}/{repo}/pull/{n}
  if (isHostOf(host, "github.com", "github")) {
    const hit = GITHUB_PULL.exec(path);
    if (hit) return claim(host, hit);
  }
  // Forgejo and Gitea use /pulls/ on arbitrary self-hosted domains.
  const forgejoHit = FORGEJO_PULL.exec(path);
  if (forgejoHit) {
    const found = claim(host, forgejoHit);
    return found && { ...found, authority: url.host.toLowerCase() };
  }
  // GitLab, self-hosted included: /{group}/[{subgroup}/...]{repo}/-/merge_requests/{n}. The `/-/`
  // separator is GitLab's own, so the hostname is not asked about.
  const gitlabHit = GITLAB_MERGE_REQUEST.exec(path);
  if (gitlabHit) return claim(host, gitlabHit);
  // Bitbucket Cloud: /{workspace}/{repo}/pull-requests/{n}
  if (isHostOf(host, "bitbucket.org", "bitbucket")) return claim(host, BITBUCKET_PULL.exec(path));
  // Azure DevOps, both the current host and the per-organisation one it replaced. `_git` is part
  // of the repository path there, as it is in the remote URL the identity is read from.
  if (isHostOf(host, "dev.azure.com") || host.endsWith(".visualstudio.com")) {
    return claim(host, AZURE_PULL.exec(path));
  }
  return null;
}

function claim(host: string, match: RegExpExecArray | null): ChangeRequestLink | null {
  const [, repository, rawNumber] = match ?? [];
  const number = Number(rawNumber);
  const valid = Boolean(repository) && Number.isSafeInteger(number) && number > 0;
  return valid ? { host, repository: repository!.toLowerCase(), number } : null;
}
