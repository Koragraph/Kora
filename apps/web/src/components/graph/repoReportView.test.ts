import { describe, expect, it } from "vite-plus/test";
import { FIXTURE_REPORT, SPARSE_REPORT } from "./repoReport.fixtures";
import {
  bridgeExampleKey,
  areaColouringUsable,
  areaLegend,
  areaNameOf,
  middleTruncate,
  nodeIdsInArea,
  routeQuestion,
  sortedAreas,
  sortedHubs,
  toneForFile,
  visibleSections,
} from "./repoReportView";

describe("visibleSections", () => {
  it("lists every section of a full report in the spec's order", () => {
    expect(visibleSections(FIXTURE_REPORT)).toEqual([
      "areas",
      "hubs",
      "entryPoints",
      "bridges",
      "hotspots",
      "cycles",
      "notes",
      "questions",
    ]);
  });
  it("hides the empty ones", () => {
    expect(visibleSections(SPARSE_REPORT)).toEqual(["areas", "entryPoints"]);
  });
});

describe("sorting", () => {
  it("puts the biggest area first, ties by name", () => {
    const names = sortedAreas(FIXTURE_REPORT).map((a) => a.id);
    expect(names[0]).toBe("web-client");
    expect(names.at(-1)).toBe("merge-gate");
  });
  it("sorts hubs by dependents", () => {
    const hubs = sortedHubs({ ...FIXTURE_REPORT, hubs: [...FIXTURE_REPORT.hubs].reverse() });
    expect(hubs.map((h) => h.dependents)).toEqual(
      [...hubs.map((h) => h.dependents)].sort((a, b) => b - a),
    );
  });
});

describe("areaNameOf", () => {
  it("finds a name, falls back to the id, and is empty for none", () => {
    expect(areaNameOf(FIXTURE_REPORT, "services-resolution")).toBe("services/resolution");
    expect(areaNameOf(FIXTURE_REPORT, "gone")).toBe("gone");
    expect(areaNameOf(FIXTURE_REPORT, null)).toBe("");
  });
});

describe("routeQuestion", () => {
  const q = (kind: "callers" | "where" | "impact" | "explore") => ({
    text: "x",
    kind,
    target: "x",
  });
  it("answers callers / where / impact from the graph when a thread is open", () => {
    for (const k of ["callers", "where", "impact"] as const)
      expect(routeQuestion(q(k), true)).toBe("quick-answer");
  });
  it("puts explore, and everything with no thread, in the composer", () => {
    expect(routeQuestion(q("explore"), true)).toBe("composer");
    expect(routeQuestion(q("callers"), false)).toBe("composer");
  });
});

describe("middleTruncate", () => {
  it("leaves a short path alone", () => {
    expect(middleTruncate("a/b.ts", 40)).toBe("a/b.ts");
  });
  it("keeps the head and the file name, cutting the middle", () => {
    const out = middleTruncate("packages/runtime/src/server/swarm/state/swarm-state.ts", 32);
    expect(out.length).toBeLessThanOrEqual(32);
    expect(out.startsWith("packages/…/")).toBe(true);
    expect(out.endsWith("swarm-state.ts")).toBe(true);
  });
  it("still fits when the file name alone is too long", () => {
    const out = middleTruncate("a/b/c/averyveryverylongfilenamethatkeepsgoing.ts", 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith(".ts")).toBe(true);
  });
});

describe("graph colouring", () => {
  const nodes = [
    { id: 1, file: "graph/store/db.ts" },
    { id: 2, file: "cli/args.ts" },
    { id: 3, file: "unplaced/x.ts" },
  ];
  it("gives the legend a stable grey per area, biggest first, within range", () => {
    const legend = areaLegend(FIXTURE_REPORT);
    expect(legend[0]!.id).toBe("web-client");
    for (const e of legend)
      (expect(e.tone).toBeGreaterThan(0), expect(e.tone).toBeLessThanOrEqual(1));
  });
  it("tones a placed file and leaves an unplaced one to the degree shade", () => {
    const legend = areaLegend(FIXTURE_REPORT);
    expect(toneForFile(FIXTURE_REPORT, legend, "cli/args.ts")).not.toBeNull();
    expect(toneForFile(FIXTURE_REPORT, legend, "unplaced/x.ts")).toBeNull();
    expect(toneForFile(null, legend, "cli/args.ts")).toBeNull();
  });
  it("lights only an area's nodes", () => {
    expect([...nodeIdsInArea(FIXTURE_REPORT, "cli", nodes)]).toEqual([2]);
  });
  it("falls back to the directory view when the report places too few nodes", () => {
    expect(areaColouringUsable(FIXTURE_REPORT, nodes)).toBe(true);
    expect(areaColouringUsable(SPARSE_REPORT, nodes)).toBe(false);
    expect(areaColouringUsable(null, nodes)).toBe(false);
    expect(
      areaColouringUsable(FIXTURE_REPORT, [
        { file: "z" },
        { file: "y" },
        { file: "w" },
        { file: "cli/args.ts" },
        { file: "q" },
        { file: "r" },
        { file: "s" },
        { file: "t" },
      ]),
    ).toBe(false);
  });
});

describe("bridgeExampleKey", () => {
  it("tells apart two same-named declarations in different files", () => {
    const a = { name: "response", file: "src/a.py", line: 3 };
    const b = { name: "response", file: "src/b.py", line: 9 };
    const m = { name: "make_response", file: "src/c.py", line: 1 };
    expect(bridgeExampleKey({ from: m, to: a })).not.toBe(bridgeExampleKey({ from: m, to: b }));
  });
});
