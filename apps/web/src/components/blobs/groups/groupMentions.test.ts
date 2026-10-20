import { describe, expect, it } from "vite-plus/test";

import { groupMentionItems } from "./groupMentions";
import type { GroupMember, GroupWire } from "./groupModel";
import type { GroupThreadInfo } from "./groupThreadContext";

const member = (id: string, name: string, title: string, chief = false): GroupMember => ({
  id,
  name,
  title,
  chief,
  outfit: {},
});
const group: GroupWire = {
  id: "group_a",
  name: "crew",
  memberIds: ["blob_popo", "blob_kora", "blob_junip"],
  leadId: "blob_kora",
  rule: "auto",
  instructions: "",
  workspace: "/w",
  pinned: false,
  archivedAt: null,
};
const info: GroupThreadInfo = {
  group,
  membersById: new Map([
    ["blob_kora", member("blob_kora", "Kora", "Chief", true)],
    ["blob_popo", member("blob_popo", "Popo", "Researcher")],
    ["blob_junip", member("blob_junip", "Junip", "Analyst")],
    // a retired blob that is no longer a member
    ["blob_gone", member("blob_gone", "Wobbo", "Writer")],
  ]),
};

describe("group @ menu", () => {
  it("offers the members (lead first) and @all, never someone outside the group", () => {
    const items = groupMentionItems(info, "");
    expect(items.map((i) => i.mention)).toEqual(["Kora", "Popo", "Junip", "all"]);
    expect(items[0]?.description).toContain("lead");
    expect(items.at(-1)?.member).toBeNull();
    expect(items.some((i) => i.mention === "Wobbo")).toBe(false);
  });

  it("filters by what was typed after the @, case-insensitively", () => {
    expect(groupMentionItems(info, "po").map((i) => i.mention)).toEqual(["Popo"]);
    expect(groupMentionItems(info, "P").map((i) => i.mention)).toEqual(["Popo", "Junip"]);
    expect(groupMentionItems(info, "al").map((i) => i.mention)).toEqual(["all"]);
    expect(groupMentionItems(info, "zzz")).toEqual([]);
  });
});
