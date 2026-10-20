import type { BlobProfile } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isNameTaken, orderRoster } from "./blobRoster";

const blob = (id: string, name: string, over: Partial<BlobProfile> = {}): BlobProfile => ({
  id,
  version: 1,
  name,
  title: "",
  role: "member",
  teamId: "default",
  engine: { instanceId: "claude", model: "sonnet", effort: null },
  permission: "auto",
  outfit: null,
  toolGrants: {
    apps: { mode: "none", allow: [] },
    mcp: [],
    computer: { browser: false, vm: false },
  },
  slug: name.toLowerCase(),
  workspace: `/tmp/Blobs/${name}`,
  templateId: null,
  pinned: false,
  hidden: false,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const kora = blob("blob_kora", "Kora", { role: "chief", createdAt: 5 });
const popo = blob("blob_popo", "Popo", { createdAt: 10 });
const bobble = blob("blob_bobble", "Bobble", { createdAt: 20 });
const dimp = blob("blob_dimp", "Dimp", { createdAt: 30, pinned: true });

describe("orderRoster", () => {
  it("puts Kora first even when listed last and even when others are more active", () => {
    const r = orderRoster([popo, bobble, kora], new Map([["blob_popo", 999]]));
    expect(r.chief?.id).toBe("blob_kora");
    expect(r.team.map((b) => b.name)).toEqual(["Popo", "Bobble"]);
  });
  it("pinned first, then most recent activity, then oldest", () => {
    const r = orderRoster(
      [kora, popo, bobble, dimp],
      new Map([
        ["blob_bobble", 50],
        ["blob_popo", 10],
      ]),
    );
    expect(r.team.map((b) => b.name)).toEqual(["Dimp", "Bobble", "Popo"]);
  });
  it("separates hidden and retired blobs from the team", () => {
    const r = orderRoster([
      kora,
      popo,
      blob("h", "Hush", { hidden: true }),
      blob("r", "Retiree", { archivedAt: 100 }),
    ]);
    expect(r.team.map((b) => b.name)).toEqual(["Popo"]);
    expect(r.hidden.map((b) => b.name)).toEqual(["Hush"]);
    expect(r.retired.map((b) => b.name)).toEqual(["Retiree"]);
  });
  it("copes with no Chief yet", () => {
    expect(orderRoster([popo]).chief).toBeNull();
  });
});

describe("isNameTaken", () => {
  it("is case-insensitive and ignores retired blobs and the blob being edited", () => {
    const all = [popo, blob("r", "Retiree", { archivedAt: 5 })];
    expect(isNameTaken(all, " popo ")).toBe(true);
    expect(isNameTaken(all, "Popo", "blob_popo")).toBe(false);
    expect(isNameTaken(all, "retiree")).toBe(false);
    expect(isNameTaken(all, "")).toBe(false);
  });
});
