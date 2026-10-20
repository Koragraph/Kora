import type { TranscriptRowEntry } from "../../thread/ThreadTranscript.logic";

import type { ChatMessage } from "../../../types";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { ItemId } from "@kora/contracts";

vi.mock("../../ui/button", () => ({
  Button: ({
    children,
    variant: _v,
    size: _s,
    ...rest
  }: {
    children?: React.ReactNode;
    [k: string]: unknown;
  }) => <button {...rest}>{children}</button>,
}));
vi.mock("../../ui/input", () => ({
  Input: ({ nativeInput: _n, size: _s, ...rest }: { [k: string]: unknown }) => <input {...rest} />,
}));
vi.mock("../../ui/textarea", () => ({
  Textarea: (p: { [k: string]: unknown }) => <textarea {...p} />,
}));
vi.mock("../../ui/dialog", () => {
  const Box = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    DialogFooter: Box,
    DialogDescription: Box,
    DialogTitle: Box,
    DialogHeader: Box,
    DialogPopup: ({ children, ...r }: { children?: React.ReactNode; [k: string]: unknown }) => (
      <div {...r}>{children}</div>
    ),
    Dialog: ({ open, children }: { open: boolean; children?: React.ReactNode }) =>
      open ? <div>{children}</div> : null,
  };
});
vi.mock("../../ui/popover", () => ({
  PopoverPopup: ({ children }: { children?: React.ReactNode }) => <div data-popup>{children}</div>,
  PopoverTrigger: ({ children, ...rest }: { children?: React.ReactNode; [k: string]: unknown }) => (
    <button {...rest}>{children}</button>
  ),
  Popover: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../ui/tooltip", () => ({
  TooltipPopup: () => null,
  TooltipTrigger: ({
    children,
    render,
  }: {
    children?: React.ReactNode;
    render?: React.ReactElement;
  }) => (render ? <button {...(render.props as object)}>{children}</button> : <>{children}</>),
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

import {
  type GroupWire,
  type GroupMember,
  validateGroupDraft,
  toggleMember,
  orderGroups,
  newGroupDraft,
  joinNames,
  isDraftDirty,
  groupMembers,
  draftIsValid,
  draftFromGroup,
  defaultLeadId,
} from "./groupModel";
import { deriveAuthorBubbleGroups, skinForAuthor } from "./groupAuthors";
import { RoutedTo, routeNote, routedLabel } from "./RoutedTo";
import { MemberStack } from "./MemberStack";
import { GroupsSection } from "./GroupsSection";
import { GroupHeaderActions, GroupHeaderIdentity } from "./GroupHeader";
import { GroupAssistantFrame } from "./GroupAuthorFrame";

import { CreateGroupDialog } from "./CreateGroupDialog";

const member = (id: string, name: string, chief = false, title = ""): GroupMember => ({
  chief,
  outfit: chief ? { head: "crown" } : { head: "beanie" },
  title,
  name,
  id,
});
const kora = member("blob_kora", "Kora", true, "Chief");
const popo = member("p", "Popo", false, "Researcher");
const junip = member("q", "Junip", false, "Analyst");
const wobbo = member("g", "Wobbo");
const ALL = [kora, popo, junip, wobbo];
const byId = new Map(ALL.map((m) => [m.id, m]));
const group = (over: Partial<GroupWire> = {}): GroupWire => ({
  id: "g1",
  name: "launch-week",
  memberIds: ["p", "blob_kora", "q"],
  leadId: "blob_kora",
  rule: "auto",
  instructions: "",
  workspace: "/w",
  pinned: false,
  archivedAt: null,
  ...over,
});

const text = (n: ReactTestInstance | string): string =>
  typeof n === "string" ? n : n.children.map(text).join("");
const byAttr = (root: ReactTestInstance, attr: string, value?: string) =>
  root.findAll(
    (n) =>
      typeof n.type === "string" &&
      (value === undefined ? attr in n.props : n.props[attr] === value),
  );
const render = (el: React.ReactElement) => {
  let r!: ReturnType<typeof create>;
  act(() => {
    r = create(el);
  });
  return r;
};

describe("group header", () => {
  it("the rule chip lists the three rules; picking another changes it, picking the current one does not", () => {
    const onChangeRule = vi.fn();
    const r = render(
      <GroupHeaderActions group={group()} onChangeRule={onChangeRule} onEdit={vi.fn()} />,
    );
    expect(byAttr(r.root, "data-rule-chip", "auto")).toHaveLength(1);
    expect(byAttr(r.root, "data-rule-menu-option")).toHaveLength(3);
    act(() => byAttr(r.root, "data-rule-menu-option", "auto")[0]?.props.onClick());
    expect(onChangeRule).not.toHaveBeenCalled();
    act(() => byAttr(r.root, "data-rule-menu-option", "mention")[0]?.props.onClick());
    expect(onChangeRule).toHaveBeenCalledWith("mention");
  });
  it("shows # name and a face per member; clicking a face opens that blob; speaking members are marked", () => {
    const onOpenMember = vi.fn();
    const r = render(
      <GroupHeaderIdentity
        group={group()}
        members={groupMembers(group(), byId)}
        speakingIds={new Set(["p"])}
        onOpenMember={onOpenMember}
      />,
    );
    expect(text(byAttr(r.root, "data-group-header-name")[0]!)).toBe("launch-week");
    const faces = byAttr(r.root, "data-group-member");
    expect(faces).toHaveLength(3);
    act(() => byAttr(r.root, "data-group-member", "p")[0]?.props.onClick());
    expect(onOpenMember).toHaveBeenCalledWith("p");
    expect(byAttr(r.root, "data-group-member", "blob_kora")[0]?.props["aria-label"]).toContain(
      "lead",
    );
  });
});

describe("CreateGroupDialog", () => {
  const setup = (over: Partial<React.ComponentProps<typeof CreateGroupDialog>> = {}) => {
    const onSubmit = vi.fn(async () => ({ ok: true as const }));
    const onOpenChange = vi.fn();
    const r = render(
      <CreateGroupDialog
        open
        onOpenChange={onOpenChange}
        members={ALL}
        existingNames={["writers"]}
        onSubmit={onSubmit}
        folderLabel={(n) => `~/Blobs/_groups/${n}`}
        {...over}
      />,
    );
    return { r, onSubmit, onOpenChange };
  };

  it("edit mode starts from the group, and Save stays disabled until something changes", () => {
    const { r } = setup({ group: group() });
    expect(byAttr(r.root, "data-group-dialog")[0]?.props["data-group-dialog"]).toBe("edit");
    expect(byAttr(r.root, "data-group-submit")[0]?.props.disabled).toBe(true);
    act(() => byAttr(r.root, "data-rule-option", "lead")[0]?.props.onClick());
    expect(byAttr(r.root, "data-group-submit")[0]?.props.disabled).toBe(false);
  });

  it("rejects a duplicate name and surfaces a server error without closing", async () => {
    const { r, onSubmit, onOpenChange } = setup({
      onSubmit: vi.fn(async () => ({ ok: false as const, message: "Daemon says no." })),
    });
    act(() =>
      byAttr(r.root, "data-group-name")[0]?.props.onChange({ target: { value: "Writers" } }),
    );
    for (const id of ["p", "q"])
      act(() => byAttr(r.root, "data-member-option", id)[0]?.props.onClick());
    await act(async () => byAttr(r.root, "data-group-submit")[0]?.props.onClick());
    expect(text(r.root)).toContain("already exists");
    act(() => byAttr(r.root, "data-group-name")[0]?.props.onChange({ target: { value: "Crew" } }));
    await act(async () => byAttr(r.root, "data-group-submit")[0]?.props.onClick());
    expect(text(r.root)).toContain("Daemon says no.");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(onSubmit).toBeDefined();
  });

  it("ticking members reveals the lead picker (Kora default), the rule picker works, submit sends the draft", async () => {
    const { r, onSubmit, onOpenChange } = setup();
    act(() => byAttr(r.root, "data-group-name")[0]?.props.onChange({ target: { value: "Crew" } }));
    for (const id of ["p", "blob_kora", "q"])
      act(() => byAttr(r.root, "data-member-option", id)[0]?.props.onClick());
    expect(byAttr(r.root, "data-lead-option")).toHaveLength(3);
    expect(byAttr(r.root, "data-lead-option", "blob_kora")[0]?.props["aria-checked"]).toBe(true);
    act(() => byAttr(r.root, "data-lead-option", "q")[0]?.props.onClick());
    act(() => byAttr(r.root, "data-rule-option", "mention")[0]?.props.onClick());
    expect(text(r.root)).toContain("They get a shared folder");
    await act(async () => byAttr(r.root, "data-group-submit")[0]?.props.onClick());
    expect(onSubmit).toHaveBeenCalledWith(
      {
        instructions: "",
        rule: "mention",
        leadId: "q",
        memberIds: ["p", "blob_kora", "q"],
        name: "Crew",
      },
      null,
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows every member with avatar and a Chief tag; Create waits for a name and two members", async () => {
    const { r, onSubmit } = setup();
    expect(byAttr(r.root, "data-member-option")).toHaveLength(4);
    expect(text(r.root)).toContain("Chief");
    await act(async () => byAttr(r.root, "data-group-submit")[0]?.props.onClick());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(text(r.root)).toContain("Give the group a name.");
    expect(text(r.root)).toContain("Pick at least 2 members.");
  });
});

describe("roster", () => {
  const props = {
    onNew: vi.fn(),
    onOpen: vi.fn(),
    canCreate: true,
    unreadByGroup: new Map([["g1", 3]]),
    activeGroupId: "g2",
    membersById: byId,
    groups: [group(), group({ id: "g2", name: "writers", memberIds: ["g", "p"], leadId: "g" })],
  };

  it("MemberStack shows at most `limit` faces then +N", () => {
    const r = render(<MemberStack members={ALL} limit={2} />);
    expect(byAttr(r.root, "data-member-face")).toHaveLength(2);
    expect(text(r.root)).toContain("+2");
  });

  it("empty states: invites a first group, or asks for a second blob", () => {
    expect(text(render(<GroupsSection {...props} groups={[]} />).root)).toContain(
      "Put several blobs in one conversation.",
    );
    const none = render(<GroupsSection {...props} groups={[]} canCreate={false} />);
    expect(text(none.root)).toContain("Hire a second blob");
    expect(byAttr(none.root, "data-new-group")).toHaveLength(0);
  });

  it("opens and creates", () => {
    const r = render(<GroupsSection {...props} />);
    act(() => byAttr(r.root, "data-group-row")[0]?.props.onClick());
    expect(props.onOpen).toHaveBeenCalledWith("g1");
    act(() => byAttr(r.root, "data-new-group")[0]?.props.onClick());
    expect(props.onNew).toHaveBeenCalled();
  });

  it("lists groups under GROUPS with # name, member stack and unread; active row is marked", () => {
    const r = render(<GroupsSection {...props} />);
    const rows = byAttr(r.root, "data-group-row");
    expect(rows).toHaveLength(2);
    expect(text(r.root)).toContain("Groups");
    expect(text(r.root)).toContain("launch-week");
    expect(byAttr(r.root, "data-group-unread").map((n) => n.props["data-group-unread"])).toEqual([
      3,
    ]);
    expect(byAttr(r.root, "data-member-stack")).toHaveLength(2);
    expect(rows.find((n) => n.props["aria-current"] === "true")?.props["aria-label"]).toContain(
      "writers",
    );
    expect(rows[0]?.props["aria-label"]).toContain("3 unread");
  });
});

describe("groupModel", () => {
  it("dirty tracking, member order, group order", () => {
    const g = group();
    const base = draftFromGroup(g);
    expect(isDraftDirty(base, base)).toBe(false);
    expect(isDraftDirty({ ...base, rule: "lead" }, base)).toBe(true);
    expect(isDraftDirty({ ...base, memberIds: ["q", "p", "blob_kora"] }, base)).toBe(false);
    expect(groupMembers(g, byId).map((m) => m.name)).toEqual(["Kora", "Popo", "Junip"]);
    expect(
      groupMembers(group({ memberIds: ["p", "ghost", "blob_kora"] }), byId).map((m) => m.name),
    ).toEqual(["Kora", "Popo"]);
    const ordered = orderGroups([
      group({ id: "b", name: "b" }),
      group({ id: "a", name: "a", pinned: true }),
      group({ id: "c", name: "c", archivedAt: 5 }),
    ]);
    expect(ordered.map((x) => x.id)).toEqual(["a", "b"]);
    expect(joinNames(["a", "b", "c"])).toBe("a, b and c");
  });

  it("validates name and member count", () => {
    const d = { ...newGroupDraft(["p"], ALL), name: "  " };
    expect(validateGroupDraft(d, []).name).toMatch(/name/);
    expect(validateGroupDraft(d, []).members).toMatch(/at least 2/);
    const ok = { ...newGroupDraft(["p", "q"], ALL), name: "Crew" };
    expect(draftIsValid(validateGroupDraft(ok, ["Other"]))).toBe(true);
    expect(validateGroupDraft(ok, ["crew"]).name).toMatch(/already exists/);
    expect(validateGroupDraft(ok, ["crew"], "Crew").name).toBeNull(); // editing itself
    expect(validateGroupDraft({ ...ok, name: "x".repeat(41) }, []).name).toMatch(/40/);
  });

  it("caps members at 12", () => {
    const many = Array.from({ length: 13 }, (_, i) => member(`m${i}`, `M${i}`));
    let d = newGroupDraft([], many);
    for (const m of many) d = toggleMember(d, m.id, many);
    expect(d.memberIds).toHaveLength(12);
  });

  it("toggleMember keeps the lead valid: the default lead follows, a chosen lead stays, removing the lead resets", () => {
    let d = newGroupDraft(["p", "q"], ALL);
    expect(d.leadId).toBe("p");
    d = toggleMember(d, "blob_kora", ALL);
    expect(d.leadId).toBe("blob_kora"); // the default followed Kora in
    d = { ...d, leadId: "q" }; // chosen on purpose
    d = toggleMember(d, "g", ALL);
    expect(d.leadId).toBe("q");
    d = toggleMember(d, "q", ALL); // lead removed
    expect(d.leadId).toBe("blob_kora");
    expect(d.memberIds).toEqual(["p", "blob_kora", "g"]);
  });
  it("defaults the lead to Kora when she is in, else the first member", () => {
    expect(defaultLeadId(["p", "blob_kora"], ALL)).toBe("blob_kora");
    expect(defaultLeadId(["q", "p"], ALL)).toBe("q");
    expect(defaultLeadId([], ALL)).toBe("");
  });
});

// ── transcript author adapter ────────────────────────────────────────────────────────────────────
const at = (s: number) => new Date(Date.UTC(2026, 9, 9, 10, 0, 0) + s * 1000).toISOString();
function msg(
  id: string,
  role: "user" | "assistant",
  s: number,
  streaming = false,
): TranscriptRowEntry {
  const message = {
    streaming,
    updatedAt: at(s),
    createdAt: at(s),
    turnId: null,
    text: id,
    role,
    id: ItemId.make(id),
  } as ChatMessage;
  return {
    assistantCopyStreaming: false,
    showAssistantCopyButton: false,
    showAssistantMeta: false,
    durationStart: at(s),
    message,
    createdAt: at(s),
    id,
    kind: "message",
  };
}

describe("author frame and routing label", () => {
  it("RoutedTo reads 'to Popo and Junip' once, with why", () => {
    expect(routedLabel([popo, junip])).toBe("to Popo and Junip");
    expect(routedLabel([])).toBe("");
    const r = render(<RoutedTo recipients={[popo, junip]} why="all" />);
    expect(text(r.root)).toContain("to Popo and Junip");
    expect(text(r.root)).toContain("everyone");
    expect(text(render(<RoutedTo recipients={[popo]} why="auto" />).root)).toContain(
      "picked for you",
    );
    expect(text(render(<RoutedTo recipients={[]} why="no-mention" />).root)).toContain(
      "mention someone",
    );
    expect(render(<RoutedTo recipients={[]} why="lead" />).toJSON()).toBeNull();
    expect(routeNote("auto-fallback", 1)).toBe("the lead took it");
    expect(routeNote("auto:keyword", 1)).toBe("picked for you (matched what they do)");
  });
  it("draws the author's name, Chief mark and avatar on the first bubble of a burst only", () => {
    const first = render(
      <GroupAssistantFrame
        skin={skinForAuthor("p", byId)}
        position={{ role: "assistant", first: true, last: true, streaming: false }}
      >
        bubble
      </GroupAssistantFrame>,
    );
    expect(text(byAttr(first.root, "data-group-author", "p")[0]!)).toContain("Popo");
    expect(text(byAttr(first.root, "data-group-author", "p")[0]!)).toContain("Researcher");
    const chief = render(
      <GroupAssistantFrame skin={skinForAuthor("blob_kora", byId)} lead position={undefined}>
        x
      </GroupAssistantFrame>,
    );
    expect(text(chief.root)).toContain("Chief");
    const later = render(
      <GroupAssistantFrame
        skin={skinForAuthor("p", byId)}
        position={{ role: "assistant", first: false, last: true, streaming: false }}
      >
        bubble
      </GroupAssistantFrame>,
    );
    expect(byAttr(later.root, "data-group-author")).toHaveLength(0);
    expect(skinForAuthor("gone", byId).name).toBe("Former member");
  });
});

describe("deriveAuthorBubbleGroups", () => {
  const authors: Record<string, string> = { a1: "p", a2: "p", a3: "q", a4: "q", a5: "p" };
  const authorOf = (id: string, role: "user" | "assistant") =>
    role === "user" ? null : (authors[id] ?? null);

  it("with one author it equals the plain grouping", () => {
    const rows = [msg("a1", "assistant", 5), msg("a2", "assistant", 8)];
    const g = deriveAuthorBubbleGroups(rows, () => "p");
    expect(g.get("a1")).toMatchObject({ first: true, last: false });
    expect(g.get("a2")).toMatchObject({ first: false, last: true });
  });

  it("tracks streaming per author run", () => {
    const rows = [msg("a1", "assistant", 5), msg("a3", "assistant", 8, true)];
    const g = deriveAuthorBubbleGroups(rows, authorOf);
    expect(g.get("a1")?.streaming).toBe(false);
    expect(g.get("a3")?.streaming).toBe(true);
  });

  it("splits an assistant burst wherever the author changes", () => {
    const rows = [
      msg("u1", "user", 0),
      msg("a1", "assistant", 5),
      msg("a2", "assistant", 8),
      msg("a3", "assistant", 11),
      msg("a4", "assistant", 14),
      msg("a5", "assistant", 17),
    ];
    const g = deriveAuthorBubbleGroups(rows, authorOf);
    expect(g.get("u1")).toMatchObject({ first: true, last: true, role: "user" });
    expect(g.get("a1")).toMatchObject({ first: true, last: false });
    expect(g.get("a2")).toMatchObject({ first: false, last: true });
    expect(g.get("a3")).toMatchObject({ first: true, last: false });
    expect(g.get("a4")).toMatchObject({ first: false, last: true });
    expect(g.get("a5")).toMatchObject({ first: true, last: true });
  });
});
