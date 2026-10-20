import { DEFAULT_DAEMON_PREFS, HostId, ProjectId } from "@kora/contracts";
import { resolveProjectPrefs } from "@kora/shared/projectPrefs";
import { describe, expect, it } from "vite-plus/test";

import { settingInheritanceLayers } from "./SettingInheritance";

describe("settingInheritanceLayers", () => {
  const host = HostId.make("workstation");
  const project = ProjectId.make("kora-repo");

  it("designates the default layer as active when configurations match system defaults", () => {
    const resolved = resolveProjectPrefs(DEFAULT_DAEMON_PREFS, null);
    const target = {
      ...resolved,
      hostId: host,
      label: "Workstation",
      projectId: null,
    };

    const results = settingInheritanceLayers(target, DEFAULT_DAEMON_PREFS, "defaultAutoPull");

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      key: "environment",
      label: "Workstation",
      value: "Inherits",
      effective: false,
    });
    expect(results[1]).toMatchObject({
      key: "built-in",
      label: "Default",
      value: "Off",
      effective: true,
    });
  });

  it("prioritizes project override ahead of environment and system defaults", () => {
    const customConfig = {
      ...DEFAULT_DAEMON_PREFS,
      defaultAutoPull: true,
      projectSettingsOverrides: {
        [project]: { defaultAutoPull: false },
      },
    };

    const resolved = resolveProjectPrefs(customConfig, project);
    const target = {
      ...resolved,
      hostId: host,
      label: "Workstation",
      projectId: project,
    };

    const results = settingInheritanceLayers(target, customConfig, "defaultAutoPull");

    expect(results).toEqual([
      {
        key: "project",
        label: "Project",
        value: "Off",
        set: true,
        effective: true,
      },
      {
        key: "environment",
        label: "Workstation",
        value: "On",
        set: true,
        effective: false,
      },
      {
        key: "built-in",
        label: "Default",
        value: "Off",
        set: true,
        effective: false,
      },
    ]);
  });

  it("falls back to environment configuration when project does not specify an override", () => {
    const customConfig = {
      ...DEFAULT_DAEMON_PREFS,
      defaultAutoPull: true,
      projectSettingsOverrides: {},
    };

    const resolved = resolveProjectPrefs(customConfig, project);
    const target = {
      ...resolved,
      hostId: host,
      label: "Workstation",
      projectId: project,
    };

    const results = settingInheritanceLayers(target, customConfig, "defaultAutoPull");

    expect(results[0]).toMatchObject({
      key: "project",
      value: "Inherits",
      set: false,
      effective: false,
    });
    expect(results[1]).toMatchObject({
      key: "environment",
      value: "On",
      set: true,
      effective: true,
    });
    expect(results[2]).toMatchObject({
      key: "built-in",
      value: "Off",
      set: true,
      effective: false,
    });
  });
});
