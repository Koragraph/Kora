import { HostId, ThreadId } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import { webRuntimeTabId } from "./webRuntimeTabId";

describe("webRuntimeTabId", () => {
  it("scopes process-local tab ids to their environment, thread, and server epoch", () => {
    const base = {
      hostId: HostId.make("environment-a"),
      threadId: ThreadId.make("thread-a"),
    };

    expect(webRuntimeTabId(base, "epoch-a", "tab_1")).not.toBe(
      webRuntimeTabId({ ...base, hostId: HostId.make("environment-b") }, "epoch-a", "tab_1"),
    );
    expect(webRuntimeTabId(base, "epoch-a", "tab_1")).not.toBe(
      webRuntimeTabId({ ...base, threadId: ThreadId.make("thread-b") }, "epoch-a", "tab_1"),
    );
    expect(webRuntimeTabId(base, "epoch-a", "tab_1")).not.toBe(
      webRuntimeTabId(base, "epoch-b", "tab_1"),
    );
  });

  it("is stable for the same runtime tab", () => {
    const ref = {
      hostId: HostId.make("environment-a"),
      threadId: ThreadId.make("thread-a"),
    };
    expect(webRuntimeTabId(ref, null, "tab_1")).toBe(webRuntimeTabId(ref, null, "tab_1"));
  });
});
