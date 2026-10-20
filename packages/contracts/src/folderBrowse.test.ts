import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { HostFsBrowseError } from "./folderBrowse.ts";

describe("filesystem browse error", () => {
  it("builds its message from the browse request, not from the cause", () => {
    const cause = new Error("EPERM: /home/someone/private-notes");
    const error = new HostFsBrowseError({
      failure: "read_directory_failed",
      partialPath: "../lib/ut",
      parentPath: "/code/lib",
      cwd: "/code/app",
      cause,
    });
    expect(error.message).toBe("Failed to browse filesystem path '../lib/ut' from '/code/app'.");
    expect(error.message.includes("private-notes")).toBe(false);
    expect(error.cause).toBe(cause);
  });

  it("still decodes the message-only form older servers send", () => {
    const old = Schema.decodeUnknownSync(HostFsBrowseError)({
      message: "Could not browse (old server).",
      _tag: "HostFsBrowseError",
    });
    expect([old.message, old.partialPath, old.failure]).toEqual([
      "Could not browse (old server).",
      undefined,
      undefined,
    ]);
  });
});
