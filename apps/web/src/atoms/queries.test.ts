import { areProjectPathSearchTargetsEqual } from "./queries";
import { describe, expect, it } from "vite-plus/test";
import { HostId } from "@kora/contracts";

describe("areProjectPathSearchTargetsEqual", () => {
  const target = {
    query: "index",
    cwd: "/project-a",
    hostId: HostId.make("environment-a"),
  };

  it("requires the environment, workspace, query, entry kind, and image filter to match", () => {
    expect(areProjectPathSearchTargetsEqual(target, target)).toBe(true);
    expect(
      areProjectPathSearchTargetsEqual(target, {
        ...target,
        hostId: HostId.make("environment-b"),
      }),
    ).toBe(false);
    expect(areProjectPathSearchTargetsEqual(target, { ...target, cwd: "/project-b" })).toBe(false);
    expect(areProjectPathSearchTargetsEqual(target, { ...target, query: "readme" })).toBe(false);
    expect(areProjectPathSearchTargetsEqual(target, { ...target, kind: "file" })).toBe(false);
    expect(areProjectPathSearchTargetsEqual(target, { ...target, imageOnly: true })).toBe(false);
  });
});
