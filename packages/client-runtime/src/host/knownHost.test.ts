import { HostId, ProjectId, ThreadId } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createKnownHost } from "./knownHost.ts";
import * as Scoped from "./scoped.ts";

describe("createKnownHost", () => {
  it("names a manual host after its label and keeps the given URLs", () => {
    const target = { wsBaseUrl: "wss://box.lan.test", httpBaseUrl: "https://box.lan.test" };
    const host = createKnownHost({ target, label: "Box" });
    expect(host).toEqual({ source: "manual", id: "ws:Box", label: "Box", target });
  });
});

describe("scoped refs", () => {
  const hostId = HostId.make("host-a");
  const projectId = ProjectId.make("p-9");
  const threadId = ThreadId.make("t-4");
  const projectRef = Scoped.hostProjectRef(hostId, projectId);
  const threadRef = Scoped.hostThreadRef(hostId, threadId);

  it("pairs the id with its host", () => {
    expect([projectRef, threadRef]).toEqual([
      { projectId, hostId },
      { threadId, hostId },
    ]);
  });

  it("joins host and id with a colon", () => {
    expect(Scoped.hostThreadKey(threadRef)).toBe("host-a:t-4");
    expect(Scoped.hostProjectKey(projectRef)).toBe("host-a:p-9");
  });

  it("reads a thread key back, and rejects one without a host", () => {
    expect(Scoped.parseHostThreadKey("no-separator")).toBeNull();
    expect(Scoped.parseHostThreadKey("host-a:t-4")).toEqual(threadRef);
  });
});
