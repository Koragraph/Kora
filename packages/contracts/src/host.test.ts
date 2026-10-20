import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { HostDescriptor, migrateLegacyHostKeys } from "./host.ts";

const describeHost = (capabilities: Record<string, unknown> = {}) =>
  Schema.decodeUnknownSync(HostDescriptor)({
    capabilities: { repositoryIdentity: true, ...capabilities },
    serverVersion: "0.1.0",
    platform: { arch: "x64", os: "linux" },
    label: "Dev box",
    hostId: "h-local",
  }).capabilities;

describe("host capabilities", () => {
  // Under version skew an older server simply does not mention newer capabilities.
  it("leaves unmentioned capabilities undefined", () => {
    const caps = describeHost();
    expect([caps.pullRequests, caps.attachmentUploads]).toEqual([undefined, undefined]);
  });

  it("keeps advertised capabilities", () => {
    const caps = describeHost({ attachmentUploads: true, pullRequests: true });
    expect([caps.pullRequests, caps.attachmentUploads]).toEqual([true, true]);
  });

  it("keeps the file upload limit", () => {
    const limit = { maxUploadBytes: 25 * 1_048_576 };
    expect(describeHost({ fileAttachments: limit }).fileAttachments).toEqual(limit);
  });
});

describe("legacy host keys", () => {
  it("renames environment-id keys at any depth and keeps their values", () => {
    expect(
      migrateLegacyHostKeys({
        byId: { "h-1": { primaryEnvironmentId: "h-1" } },
        targets: [{ label: "Here", environmentId: "h-1" }],
        disabledEnvironmentIds: ["h-2"],
        environmentId: "h-1",
      }),
    ).toEqual({
      byId: { "h-1": { primaryHostId: "h-1" } },
      targets: [{ label: "Here", hostId: "h-1" }],
      disabledHostIds: ["h-2"],
      hostId: "h-1",
    });
  });

  it("returns the very same object when nothing needs renaming", () => {
    const current = {
      hostId: "h-1",
      "environment:h-1": false,
      environment: [{ value: "/usr/bin", name: "PATH" }],
    };
    expect(migrateLegacyHostKeys(current)).toBe(current);
  });

  it("keeps the current key when both spellings are present", () => {
    expect(migrateLegacyHostKeys({ hostId: "now", environmentId: "then" })).toEqual({
      hostId: "now",
    });
  });
});
