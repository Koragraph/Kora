import { describe, expect, it } from "vite-plus/test";
import { describeRpcTag } from "./SlowRequestToasts";

describe("describeRpcTag", () => {
  it("names requests in plain words", () => {
    expect(describeRpcTag("fleet.merge")).toBe("Merging a worker");
    expect(describeRpcTag("workspace.files.read")).toBe("Reading project files");
    expect(describeRpcTag("pty.write")).toBe("Talking to a terminal");
    expect(describeRpcTag("daemon.prefs.update")).toBe("Syncing Kora's settings");
    expect(describeRpcTag("something.unknown")).toBe("Talking to Kora's local service");
  });
});
