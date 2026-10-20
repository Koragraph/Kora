import { describe, expect, it } from "vite-plus/test";

import { resolveShellAppControlAddress } from "./shellAppControl.ts";

type Input = Parameters<typeof resolveShellAppControlAddress>[0];

const posix = (stateDir: string): Input => ({
  platform: "darwin",
  stateDir,
  tempDir: "/private/tmp",
  userId: 501,
  joinPath: (...parts) => parts.join("/"),
});

describe("shell app control address", () => {
  it("puts a short socket in a per-user temp folder, unique per state dir", () => {
    const deep = resolveShellAppControlAddress(posix(`/Users/me/${"nested/".repeat(50)}state`));
    const other = resolveShellAppControlAddress(posix("/Users/me/.kora-dev/state"));

    expect(deep.directory).toBe("/private/tmp/kora-501");
    // sun_path is 104 bytes on macOS and 108 on Linux.
    expect(deep.address.length).toBeLessThan(104);
    expect(deep.address).not.toEqual(other.address);
  });

  it("uses a hashed named pipe on Windows and no folder", () => {
    const pipe = resolveShellAppControlAddress({
      platform: "win32",
      stateDir: "D:\\Profiles\\me\\.kora\\state",
      tempDir: "D:\\Tmp",
      userId: undefined,
      joinPath: (...parts) => parts.join("\\"),
    });
    expect(pipe.directory).toBeNull();
    expect(pipe.address.startsWith("\\\\.\\pipe\\kora-app-")).toBe(true);
    expect(pipe.address.slice("\\\\.\\pipe\\kora-app-".length)).toMatch(/^[0-9a-f]{24}$/);
  });
});
