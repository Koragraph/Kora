// Group chats on the web: wire twins (the runtime's GroupProfile, docs/bots/GROUPS.md), the create/edit draft, labels and
// the little pure helpers the roster, header and transcript share. No React, no RPC.
import type { BlobOutfit } from "~/components/blobs/avatar";

export type ResponderRule = "mention" | "lead" | "auto";
export const RESPONDER_RULES: readonly ResponderRule[] = ["auto", "lead", "mention"];

export const GROUP_NAME_MAX = 40;
export const GROUP_INSTRUCTIONS_MAX = 4_000;
const GROUP_MIN_MEMBERS = 2;
export const GROUP_MAX_MEMBERS = 12;

/** The runtime's GroupProfile, as the client sees it (plus the unread count the roster derives from the group thread). */
export interface GroupWire {
  readonly id: string;
  readonly name: string;
  readonly memberIds: ReadonlyArray<string>;
  readonly leadId: string;
  readonly rule: ResponderRule;
  readonly instructions: string;
  /** Absolute path of the shared folder. */
  readonly workspace: string;
  readonly pinned: boolean;
  readonly archivedAt: number | null;
}

/** A blob as a group sees it: enough to draw an avatar and a name. Built from a roster entry. */
export interface GroupMember {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly outfit: BlobOutfit;
  readonly chief: boolean;
}

export const RULE_LABEL: Record<ResponderRule, string> = {
  auto: "Auto",
  lead: "Lead answers",
  mention: "When mentioned",
};

export const RULE_SHORT: Record<ResponderRule, string> = {
  auto: "Auto",
  lead: "Lead",
  mention: "@mention",
};

export const RULE_HELP: Record<ResponderRule, string> = {
  auto: "A quick model picks the one member who fits best. The lead answers if it is unsure.",
  lead: "Every message goes to the lead. @mention someone to bring them in.",
  mention: "Nobody answers unless you @mention them. @all asks everyone.",
};

export interface GroupDraft {
  name: string;
  memberIds: ReadonlyArray<string>;
  leadId: string;
  rule: ResponderRule;
  instructions: string;
}

/** Kora leads when she is a member, else the first member. */
export function defaultLeadId(
  memberIds: ReadonlyArray<string>,
  members: ReadonlyArray<GroupMember>,
): string {
  const chief = members.find((m) => m.chief && memberIds.includes(m.id));
  return chief?.id ?? memberIds[0] ?? "";
}

export function newGroupDraft(
  preselect: ReadonlyArray<string> = [],
  members: ReadonlyArray<GroupMember> = [],
): GroupDraft {
  return {
    name: "",
    memberIds: preselect,
    leadId: defaultLeadId(preselect, members),
    rule: "auto",
    instructions: "",
  };
}

export function draftFromGroup(g: GroupWire): GroupDraft {
  return {
    name: g.name,
    memberIds: g.memberIds,
    leadId: g.leadId,
    rule: g.rule,
    instructions: g.instructions,
  };
}

/** Toggling a member keeps the lead valid: removing the lead hands it back to the default. */
export function toggleMember(
  draft: GroupDraft,
  id: string,
  members: ReadonlyArray<GroupMember>,
): GroupDraft {
  const has = draft.memberIds.includes(id);
  if (!has && draft.memberIds.length >= GROUP_MAX_MEMBERS) return draft;
  const memberIds = has ? draft.memberIds.filter((m) => m !== id) : [...draft.memberIds, id];
  // a lead the person chose on purpose stays while it is a member; the default lead keeps following the default
  const followsDefault = draft.leadId === defaultLeadId(draft.memberIds, members);
  const leadId =
    !followsDefault && memberIds.includes(draft.leadId)
      ? draft.leadId
      : defaultLeadId(memberIds, members);
  return { ...draft, memberIds, leadId };
}

export interface DraftProblems {
  readonly name: string | null;
  readonly members: string | null;
}

export function validateGroupDraft(
  draft: GroupDraft,
  existingNames: ReadonlyArray<string>,
  selfName?: string,
): DraftProblems {
  const name = draft.name.trim();
  let nameProblem: string | null = null;
  if (name.length === 0) nameProblem = "Give the group a name.";
  else if (name.length > GROUP_NAME_MAX) nameProblem = `At most ${GROUP_NAME_MAX} characters.`;
  else if (
    existingNames.some(
      (n) =>
        n.toLowerCase() === name.toLowerCase() &&
        n.toLowerCase() !== (selfName ?? "").toLowerCase(),
    )
  ) {
    nameProblem = "A group with that name already exists.";
  }
  const members =
    draft.memberIds.length < GROUP_MIN_MEMBERS
      ? `Pick at least ${GROUP_MIN_MEMBERS} members.`
      : null;
  return { name: nameProblem, members };
}

export const draftIsValid = (p: DraftProblems): boolean => p.name === null && p.members === null;

export function isDraftDirty(draft: GroupDraft, base: GroupDraft): boolean {
  return (
    draft.name.trim() !== base.name.trim() ||
    draft.rule !== base.rule ||
    draft.leadId !== base.leadId ||
    draft.instructions.trim() !== base.instructions.trim() ||
    draft.memberIds.length !== base.memberIds.length ||
    draft.memberIds.some((id) => !base.memberIds.includes(id))
  );
}

/** "Popo", "Popo and Junip", "Popo, Junip and Wobbo". */
export function joinNames(names: ReadonlyArray<string>): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Group members in display order: the lead first, then the rest as stored. Unknown ids (a deleted blob) are dropped. */
export function groupMembers(
  group: GroupWire,
  byId: ReadonlyMap<string, GroupMember>,
): GroupMember[] {
  const ordered = [group.leadId, ...group.memberIds.filter((id) => id !== group.leadId)];
  return ordered.map((id) => byId.get(id)).filter((m): m is GroupMember => m !== undefined);
}

/** Roster rows: pinned first, then by name. Archived groups never show. */
export function orderGroups(groups: ReadonlyArray<GroupWire>): GroupWire[] {
  return groups
    .filter((g) => g.archivedAt === null)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name));
}

/** "# launch-week" — the name as the roster and header draw it. */
const groupTitle = (g: Pick<GroupWire, "name">): string => g.name;

/** Screen-reader sentence for a roster row. */
export function groupAriaLabel(
  g: GroupWire,
  members: ReadonlyArray<GroupMember>,
  unread: number,
): string {
  const who = joinNames(members.map((m) => m.name));
  return `Group ${g.name}${who ? `, with ${who}` : ""}${unread > 0 ? `, ${unread} unread` : ""}`;
}
