import { describe, expect, it } from "vite-plus/test";

import type { GraphFreshness } from "../../hooks/useGraphFreshness";
import { CODE_STARTERS, indexLineFor } from "./DraftFreshStart";

const base: GraphFreshness = {
  indexed: false,
  repo: null,
  branch: null,
  indexedSha: null,
  headSha: null,
  stale: false,
  nodes: 0,
  files: 0,
  indexing: null,
  safeToIndex: true,
  isGitRepo: true,
};

describe("indexLineFor (a new project's index, in one honest line)", () => {
  it("indexing: progress, local, and that chatting can start now", () => {
    const line = indexLineFor({ ...base, indexing: { pct: 42 } }, "app", true);
    expect(line).toMatchObject({ tone: "busy" });
    expect(line?.text).toContain("Indexing app · 42%");
    expect(line?.text).toContain("never leaves this Mac");
    expect(line?.text).toContain("You can start chatting now");
  });

  it("done: said on a brand-new project only (the header chip says it afterwards)", () => {
    const indexed = { ...base, indexed: true, files: 12 };
    expect(indexLineFor(indexed, "app", true)).toMatchObject({ tone: "done" });
    expect(indexLineFor(indexed, "app", true)?.text).toContain("12 files");
    expect(indexLineFor(indexed, "app", false)).toBeNull();
    expect(indexLineFor({ ...indexed, files: 1 }, "app", true)?.text).toContain("(1 file,");
  });

  it("a plain folder: what still works, what doesn't, and Index anyway (A4)", () => {
    const line = indexLineFor({ ...base, safeToIndex: false, isGitRepo: false }, "notes", true);
    expect(line?.text).toContain("isn't a git repo");
    expect(line?.text).toContain("Chat works");
    expect(line?.text).toContain("Swarm workers will share it");
    expect(line?.action).toEqual({ label: "Index anyway", force: true });
  });

  it("a home or system folder is never offered an index", () => {
    const line = indexLineFor({ ...base, safeToIndex: false, systemFolder: true }, "~", true);
    expect(line?.text).toContain("never indexes a home or system folder");
    expect(line?.action).toBeUndefined();
  });

  it("a failed index says why, with Retry", () => {
    const line = indexLineFor(
      { ...base, ingestError: { message: "disk full", at: "2026-10-04T00:00:00Z" } },
      "app",
      true,
    );
    expect(line).toMatchObject({ tone: "problem", action: { label: "Retry", force: false } });
    expect(line?.text).toContain("disk full");
  });

  it("starters are complete prompts (a click sends them as written)", () => {
    expect(CODE_STARTERS).toHaveLength(3);
    for (const starter of CODE_STARTERS) expect(starter.prompt.length).toBeGreaterThan(40);
  });
});
