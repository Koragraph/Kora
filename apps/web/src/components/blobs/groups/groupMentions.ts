// The "@" menu in a group chat: its members and "@all". Pure; the composer turns these into menu items.
import type { GroupThreadInfo } from "./groupThreadContext";
import { groupMembers, type GroupMember } from "./groupModel";

/** Words the router reads as "everyone" (runtime groups/mentions.ts ALL_WORDS). */
const ALL_MENTION_WORDS = ["all", "everyone", "team", "group", "everybody"] as const;

export interface GroupMentionItem {
  readonly mention: string;
  readonly description: string;
  readonly member: GroupMember | null;
}

export function groupMentionItems(group: GroupThreadInfo, query: string): GroupMentionItem[] {
  const q = query.trim().toLowerCase();
  const people = groupMembers(group.group, group.membersById);
  const items: GroupMentionItem[] = people.map((m) => ({
    mention: m.name,
    description: m.id === group.group.leadId ? `${m.title ? `${m.title} · ` : ""}lead` : m.title,
    member: m,
  }));
  items.push({ mention: "all", description: "Ask everyone in the group", member: null });
  if (!q) return items;
  return items.filter(
    (i) => i.mention.toLowerCase().startsWith(q) || i.mention.toLowerCase().includes(q),
  );
}
