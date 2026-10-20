import { describe, expect, it } from "vite-plus/test";

import { latestThreadForSurface } from "./useSurfaceSwitch.logic";

const projects = [
  { hostId: "h", id: "repo", surface: "code" },
  { hostId: "h", id: "legacy" },
  { hostId: "h", id: "blob_kora", surface: "blobs" },
  { hostId: "h", id: "blob_popo", surface: "blobs" },
];
const thread = (id: string, projectId: string, updatedAt: string, archivedAt?: string) => ({
  hostId: "h",
  id,
  projectId,
  updatedAt,
  archivedAt: archivedAt ?? null,
});
const threads = [
  thread("t-code", "repo", "2026-10-08T10:00:00Z"),
  thread("t-legacy", "legacy", "2026-10-08T09:00:00Z"),
  thread("t-kora", "blob_kora", "2026-10-08T08:00:00Z"),
  thread("t-popo", "blob_popo", "2026-10-08T12:00:00Z"),
  thread("t-popo-old", "blob_popo", "2026-10-08T13:00:00Z", "2026-10-08T13:30:00Z"),
];

describe("latestThreadForSurface", () => {
  it("Kora picks the newest blob thread and never a code one", () => {
    expect(latestThreadForSurface(projects, threads, "blobs")?.id).toBe("t-popo");
  });
  it("Code keeps its own filter; blob threads never leak in", () => {
    expect(latestThreadForSurface(projects, threads, "code")?.id).toBe("t-code");
  });
  it("skips archived threads", () => {
    expect(latestThreadForSurface(projects, threads, "blobs")?.id).not.toBe("t-popo-old");
  });
  it("a retired blob's threads are excluded", () => {
    expect(latestThreadForSurface(projects, threads, "blobs", new Set(["blob_popo"]))?.id).toBe(
      "t-kora",
    );
  });
  it("is null when the surface has nothing", () => {
    expect(latestThreadForSurface(projects, [threads[0]!], "blobs")).toBeNull();
  });
});
