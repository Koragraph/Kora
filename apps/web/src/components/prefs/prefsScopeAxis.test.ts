import { HostId } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  hostAxisValue,
  prefsScopeHostLabel,
  projectAxisValue,
  selectHostAxis,
  selectProjectAxis,
} from "./prefsScopeAxis";

const staging = {
  hostId: HostId.make("stg"),
  label: "Staging",
  displayUrl: "https://stg.example.org",
};
const prod = {
  hostId: HostId.make("prd"),
  label: "Staging",
  displayUrl: "https://prd.example.org",
};

describe("axis values read from a scope", () => {
  it.each([
    [
      "a legacy checkout link shows the checkout's host",
      { project: "web", checkout: "w1" },
      "mac",
      "mac",
    ],
    ["a project with no host and no fallback is 'all'", { project: "web" }, null, "all"],
    ["an explicit machine wins over the fallback", { machine: "tower" }, "mac", "tower"],
  ] as const)("host axis: %s", (_label, scope, fallback, expected) => {
    expect(hostAxisValue(scope, fallback)).toBe(expected);
  });

  it.each([
    [{}, "all"],
    [{ project: "web" }, "web"],
  ])("project axis of %j is %s", (scope, expected) => {
    expect(projectAxisValue(scope)).toBe(expected);
  });
});

describe("changing an axis", () => {
  const legacy = { project: "web", checkout: "web@one", machine: "one" };

  it("drops the legacy checkout narrowing from either axis", () => {
    expect(selectHostAxis(legacy, "two")).toEqual({ machine: "two", project: "web" });
    expect(selectProjectAxis(legacy, "web")).toEqual({ project: "web", machine: "one" });
  });

  it("sets the project while keeping the machine", () => {
    expect(selectProjectAxis({ machine: "two" }, "web")).toEqual({
      machine: "two",
      project: "web",
    });
  });

  it("clears the project when 'all' is chosen", () => {
    expect(selectProjectAxis({ machine: "two", project: "web" }, "all")).toEqual({
      machine: "two",
    });
  });

  it("sets the machine while keeping the project", () => {
    expect(selectHostAxis({ project: "web" }, "one")).toEqual({ machine: "one", project: "web" });
  });

  it("clears the machine when 'all' is chosen", () => {
    expect(selectHostAxis({ project: "web", machine: "one" }, "all")).toEqual({ project: "web" });
  });
});

describe("prefsScopeHostLabel", () => {
  it("uses the bare name when it is unique", () => {
    expect(prefsScopeHostLabel(staging, [staging])).toBe("Staging");
  });

  it("stays bare once a former duplicate has been renamed", () => {
    expect(prefsScopeHostLabel(staging, [staging, { ...prod, label: "Production" }])).toBe(
      "Staging",
    );
  });

  it("appends the address to tell same-named hosts apart", () => {
    const hosts = [staging, prod];
    expect(hosts.map((host) => prefsScopeHostLabel(host, hosts))).toEqual([
      "Staging · https://stg.example.org",
      "Staging · https://prd.example.org",
    ]);
  });

  it("appends the host id when same-named hosts have no address", () => {
    const hosts = [staging, prod].map((host) => ({ ...host, displayUrl: null }));
    expect(hosts.map((host) => prefsScopeHostLabel(host, hosts))).toEqual([
      "Staging · stg",
      "Staging · prd",
    ]);
  });
});
