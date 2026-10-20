import { describe, expect, it } from "vite-plus/test";

import { parseChangeRequestUrl as parse } from "./mergeRequestUrl.ts";

const link = (host: string, repository: string, number: number) => ({ host, repository, number });

describe("change request URLs", () => {
  describe("recognised hosts", () => {
    const cases: ReadonlyArray<readonly [string, string, ReturnType<typeof link>]> = [
      [
        "github.com, repository lower-cased",
        "https://github.com/Owner/Repo/pull/88",
        link("github.com", "owner/repo", 88),
      ],
      [
        "GitHub Enterprise",
        "https://github.corp.example/infra/tools/pull/4",
        link("github.corp.example", "infra/tools", 4),
      ],
      [
        "gitlab.com with subgroups",
        "https://gitlab.com/org/sub/app/-/merge_requests/31",
        link("gitlab.com", "org/sub/app", 31),
      ],
      [
        "self-hosted GitLab",
        "https://git.corp.example/dept/app/-/merge_requests/2",
        link("git.corp.example", "dept/app", 2),
      ],
      [
        "Bitbucket",
        "https://bitbucket.org/team/svc/pull-requests/12",
        link("bitbucket.org", "team/svc", 12),
      ],
      [
        "Azure DevOps",
        "https://dev.azure.com/org/proj/_git/svc/pullrequest/600",
        link("dev.azure.com", "org/proj/_git/svc", 600),
      ],
      [
        "legacy visualstudio.com",
        "https://org.visualstudio.com/proj/_git/svc/pullrequest/600",
        link("org.visualstudio.com", "proj/_git/svc", 600),
      ],
      [
        "a sub-page with a query",
        "https://github.com/owner/repo/pull/88/commits?page=2",
        link("github.com", "owner/repo", 88),
      ],
      [
        "a trailing slash",
        "https://github.com/owner/repo/pull/88/",
        link("github.com", "owner/repo", 88),
      ],
    ];

    it.each(cases)("%s", (_label, url, expected) => {
      expect(parse(url)).toEqual(expected);
    });

    it("treats /pulls/ as Forgejo and keeps its authority, even on a github-named host", () => {
      expect(parse("https://github.lan/ops/infra/pulls/15")).toEqual({
        ...link("github.lan", "ops/infra", 15),
        authority: "github.lan",
      });
    });
  });

  it.each([
    "https://github.com/owner/repo/issues/88",
    "https://github.com/owner/repo/commit/deadbeef",
    "https://github.com/owner/repo",
    "https://github.com/owner/repo/pull/eighty",
    "https://gitlab.com/owner/repo/-/issues/3",
    "https://news.example.org/2025/06/pull/9",
    "javascript:void(0)//github.com/owner/repo/pull/1",
    "definitely not a link",
  ])("returns null for %s", (url) => {
    expect(parse(url)).toBeNull();
  });
});
