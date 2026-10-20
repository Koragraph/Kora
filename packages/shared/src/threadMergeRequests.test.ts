import * as Contracts from "@kora/contracts";
import type { ThreadMergeRequestLink, ThreadMergeRequestSnapshot } from "@kora/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import * as PullRequests from "./threadMergeRequests.ts";

// The mobile JS engine lacks these ES2023 array methods, and this module runs on its home
// list, so hide them for every test.
const MISSING_ON_MOBILE = ["toSpliced", "toReversed", "toSorted"] as const;
beforeEach(() => {
  const saved = new Map(
    MISSING_ON_MOBILE.map((name) => [name, Object.getOwnPropertyDescriptor(Array.prototype, name)]),
  );
  MISSING_ON_MOBILE.forEach((name) => Reflect.deleteProperty(Array.prototype, name));
  return () => {
    saved.forEach((descriptor, name) => {
      if (descriptor !== undefined) Reflect.defineProperty(Array.prototype, name, descriptor);
    });
  };
});

const REPO = "octo/app";
const prUrl = (n: number) => `https://github.com/${REPO}/pull/${n}`;

const synced = (
  title: string,
  state: ThreadMergeRequestSnapshot["state"],
): ThreadMergeRequestSnapshot => ({
  title,
  state,
  isDraft: false,
  baseBranch: "trunk",
  headBranch: "topic",
  updatedAt: "2025-05-05T10:00:00.000Z",
  syncedAt: "2025-05-05T10:00:00.000Z",
});

const pr = (
  n: number,
  overrides: Partial<ThreadMergeRequestLink> = {},
): ThreadMergeRequestLink => ({
  number: n,
  host: "github.com",
  repository: REPO,
  url: prUrl(n),
  stack: null,
  snapshot: null,
  linkedAt: `2025-05-05T10:00:${String(n).padStart(2, "0")}.000Z`,
  source: "manual",
  ...overrides,
});

describe("merge request keys", () => {
  const forgejo = pr(7, {
    host: "git.lan",
    repository: "ops/infra",
    url: "http://git.lan:8080/ops/infra/pulls/7",
  });

  it("reads the port back out of an old URL so it matches the new host:port key", () => {
    expect(
      PullRequests.threadMergeRequestKeysEqual(forgejo, { ...forgejo, host: "git.lan:8080" }),
    ).toBe(true);
    expect(
      PullRequests.threadMergeRequestKeysEqual(forgejo, {
        number: 7,
        repository: "ops/infra",
        host: "git.lan:8080",
      }),
    ).toBe(true);
  });

  it("keeps two servers on different ports apart", () => {
    const otherPort = { ...forgejo, url: "http://git.lan:9090/ops/infra/pulls/7" };
    expect(PullRequests.threadMergeRequestKeysEqual(forgejo, otherPort)).toBe(false);
  });

  it("compares host and repository case-insensitively but never across hosts", () => {
    const key = { host: "github.com", repository: REPO, number: 3 };
    expect(
      PullRequests.threadMergeRequestKeysEqual(
        { ...key, host: "GITHUB.com", repository: "Octo/App" },
        key,
      ),
    ).toBe(true);
    expect(PullRequests.threadMergeRequestKeysEqual(key, { ...key, host: "gitlab.com" })).toBe(
      false,
    );
  });
});

describe("merge request search terms", () => {
  it("covers synced, unsynced and merged links and hides dismissed ones", () => {
    const terms = PullRequests.threadMergeRequestSearchTerms({
      pullRequests: [
        pr(21, { snapshot: synced("Speed up boot", "merged") }),
        pr(43),
        pr(65, { source: "stack-dismissed" }),
      ],
    });
    for (const term of ["#21", `${REPO}#21`, prUrl(21), "Speed up boot", "#43"]) {
      expect(terms).toContain(term);
    }
    expect(terms.some((term) => term.includes("65"))).toBe(false);
  });

  describe("legacy single link", () => {
    const legacy = {
      projectId: Contracts.ProjectId.make("p"),
      repository: REPO,
      number: 21,
      url: prUrl(21),
    };

    it("is searched when the links list is empty", () => {
      expect(
        PullRequests.threadMergeRequestSearchTerms({ pullRequests: [], linkedPullRequest: legacy }),
      ).toContain("#21");
    });

    it("is ignored once real links exist", () => {
      expect(
        PullRequests.threadMergeRequestSearchTerms({
          pullRequests: [pr(43)],
          linkedPullRequest: legacy,
        }),
      ).not.toContain("#21");
    });
  });
});
