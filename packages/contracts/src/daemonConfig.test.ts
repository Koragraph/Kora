import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { HostDescriptor } from "./host.ts";
import * as Server from "./daemonConfig.ts";
import { DaemonPrefs } from "./clientPrefs.ts";

const status = Schema.decodeUnknownSync(Server.AgentStatus);
const CHECKED = "2025-07-07T07:07:07.000Z";

/** A healthy, signed-in agent with no models; tests spread their own fields over it. */
const readyAgent = (extra: Record<string, unknown> = {}) => ({
  checkedAt: CHECKED,
  auth: { status: "authenticated" },
  status: "ready",
  models: [],
  version: "2.3.4",
  installed: true,
  enabled: true,
  driver: "codex",
  instanceId: "codex",
  ...extra,
});

describe("agent status", () => {
  it("fills in empty capability lists and leaves advisory/update unset", () => {
    const parsed = status(readyAgent());
    expect([parsed.slashCommands, parsed.skills]).toEqual([[], []]);
    expect(parsed.versionAdvisory ?? parsed.updateState).toBeUndefined();
  });

  it("assumes an old advisory cannot update in one click", () => {
    const parsed = status(
      readyAgent({
        versionAdvisory: {
          status: "behind_latest",
          message: "A newer version exists.",
          checkedAt: CHECKED,
          currentVersion: "2.3.4",
          latestVersion: "2.4.0",
          updateCommand: "npm i -g @openai/codex@latest",
        },
      }),
    );
    expect(parsed.versionAdvisory?.canUpdate).toBe(false);
  });

  it("keeps the continuation group key", () => {
    const groupKey = "codex:home:/home/dev/.codex";
    const parsed = status(readyAgent({ instanceId: "codex_home", continuation: { groupKey } }));
    expect(parsed.continuation?.groupKey).toBe(groupKey);
  });

  it("keeps the legacy flag on a model", () => {
    const model = {
      capabilities: null,
      isLegacy: true,
      isCustom: false,
      name: "GPT-5.2",
      slug: "gpt-5.2",
    };
    expect(status(readyAgent({ models: [model] })).models[0]?.isLegacy).toBe(true);
  });
});

// An older client must not lose every agent (or the whole server config, which embeds the
// list) because one entry uses a value it has never seen. Unknown pieces are dropped instead.
describe("forward compatibility", () => {
  it("skips editor ids it does not know", () => {
    const editors = Schema.decodeUnknownSync(Server.DaemonConfig.fields.availableEditors);
    expect(editors(["vscode", "editor-from-2030", "zed"])).toEqual(["vscode", "zed"]);
  });

  it("skips an agent whose status it cannot read and keeps the rest", () => {
    const list = Schema.decodeUnknownSync(Server.AgentStatuses)([
      readyAgent(),
      readyAgent({ instanceId: "later", status: "hibernating" }),
    ]);
    expect(list).toEqual([status(readyAgent())]);
  });

  it("skips usage windows it cannot read and keeps the agent", () => {
    const session = { id: "primary", kind: "session", label: "Session", usedPercent: 40 };
    const parsed = status(
      readyAgent({
        usageLimits: {
          checkedAt: CHECKED,
          windows: [
            session,
            { id: "x", kind: "fortnightly", label: "Fortnight", usedPercent: 5 },
            { id: "y", kind: "weekly", label: "Weekly", usedPercent: 150 },
          ],
        },
      }),
    );
    expect(parsed.usageLimits?.windows).toEqual([session]);
  });
});

describe("host machine kind", () => {
  const prefs = Schema.decodeUnknownSync(DaemonPrefs);
  const host = (machine?: string) =>
    Schema.decodeUnknownSync(HostDescriptor)({
      hostId: "h-1",
      label: "Workstation",
      serverVersion: "2.0.0",
      capabilities: {},
      platform: { arch: "arm64", os: "darwin", ...(machine === undefined ? {} : { machine }) },
    });

  it.each([
    ["the user's pick beats detection", "mac-mini", { hostIcon: "laptop" }, "laptop"],
    ["detection is used without a pick", "mac-mini", {}, "mac-mini"],
    ["an older server reports nothing", undefined, {}, "server"],
  ] as const)("%s", (_label, machine, saved, expected) => {
    expect(
      Server.resolveHostMachineKind({ environment: host(machine), settings: prefs(saved) }),
    ).toBe(expected);
  });

  it("is a server before anything is connected", () => {
    expect(Server.resolveHostMachineKind(null)).toBe("server");
  });

  it("drops a machine kind from a newer build instead of failing the descriptor", () => {
    const descriptor = host("smart-fridge");
    expect(descriptor.platform.machine).toBeUndefined();
    expect(Server.resolveHostMachineKind({ environment: descriptor, settings: prefs({}) })).toBe(
      "server",
    );
  });
});
