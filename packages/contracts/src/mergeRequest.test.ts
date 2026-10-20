import { describe, expect, it } from "vite-plus/test";

import { mergeRequestHostOf } from "./mergeRequest.ts";

describe("merge request host", () => {
  const httpRemote = {
    locator: { remoteUrl: "http://git.lan:8080/ops/infra.git" },
    canonicalKey: "git.lan/ops/infra",
  };

  it("keeps the HTTP port for Forgejo, where servers on one host differ by port", () => {
    expect(mergeRequestHostOf(httpRemote, "forgejo")).toBe("git.lan:8080");
  });

  it("drops the port for other providers", () => {
    expect(mergeRequestHostOf(httpRemote, "gitlab")).toBe("git.lan");
  });

  it("ignores an SSH port, which says nothing about the web server", () => {
    const sshRemote = {
      ...httpRemote,
      locator: { remoteUrl: "ssh://git@git.lan:2200/ops/infra.git" },
    };
    expect(mergeRequestHostOf(sshRemote, "forgejo")).toBe("git.lan");
  });
});
