// The real `create_group` (replaces the Phase 2 placeholder in tools-team.ts; see WIRING.md) plus `list_groups`.
// Kora-only, like every team tool. Creating a group is cheap and reversible (delete it from the roster), so it applies
// at once on the user's ask and answers with a receipt; `onCreated` lets the host show a toast / card.
import type { FleetToolResult, FleetToolSpec } from '../../session/fleet-tools';
import type { BlobProfile } from '../types';
import { CHIEF_BLOB_ID } from '../types';
import { GroupStoreError, type GroupStore } from './store';
import { RESPONDER_RULES, type GroupProfile, type ResponderRule } from './types';

const ok = (text: string): FleetToolResult => ({ text });
const bad = (text: string): FleetToolResult => ({ text, isError: true });

export interface GroupToolDeps {
  groups: GroupStore;
  /** Resolve "Popo" / an id to an active blob (TeamService.resolveBlob). */
  resolveBlob(ref: string): BlobProfile | null;
  /** The blob that is calling; the tool refuses anyone but the Chief. */
  callerId: string;
  onCreated?(g: GroupProfile): void;
}

export function groupToolSpecs(d: GroupToolDeps): FleetToolSpec[] {
  const guard = (fn: (a: Record<string, unknown>) => FleetToolResult) => async (a: Record<string, unknown>): Promise<FleetToolResult> => {
    if (d.callerId !== CHIEF_BLOB_ID) return bad('Only Kora can create groups.');
    try { return fn(a ?? {}); } catch (e: any) { return bad(e instanceof GroupStoreError ? e.message : String(e?.message ?? e)); }
  };
  return [
    {
      name: 'create_group',
      description: 'Create a group chat where several blobs (you can be one) share a conversation and a folder. The user then talks in the group; the responder rule decides who answers an un-addressed message (auto = a quick model picks the best fit, lead = the lead, mention = only @mentioned blobs).',
      params: {
        name: { type: 'string', description: 'e.g. launch-week' },
        members: { type: 'string[]', description: 'blob names; you are added automatically unless include_kora is false' },
        lead: { type: 'string', optional: true, description: 'one of the members; default you' },
        rule: { type: 'string', optional: true, enum: RESPONDER_RULES, description: 'auto (default) | lead | mention' },
        instructions: { type: 'string', optional: true, description: 'shared instructions every member reads' },
        include_kora: { type: 'boolean', optional: true, description: 'default true' },
      },
      handler: guard((a) => {
        const refs = Array.isArray(a.members) ? (a.members as unknown[]).map(String) : [];
        const blobs: BlobProfile[] = [];
        for (const r of refs) { const b = d.resolveBlob(r); if (!b) return bad(`No active blob called "${r}". Call list_team for the names.`); blobs.push(b); }
        const ids = blobs.map((b) => b.id);
        if (a.include_kora !== false && !ids.includes(CHIEF_BLOB_ID)) ids.unshift(CHIEF_BLOB_ID);
        let leadId: string | undefined;
        if (typeof a.lead === 'string' && a.lead.trim()) {
          const l = d.resolveBlob(a.lead); if (!l) return bad(`No active blob called "${a.lead}" to lead.`);
          leadId = l.id;
        }
        const rule = RESPONDER_RULES.includes(a.rule as ResponderRule) ? (a.rule as ResponderRule) : undefined;
        const g = d.groups.create({ name: String(a.name ?? ''), memberIds: ids, ...(leadId ? { leadId } : {}), ...(rule ? { rule } : {}), instructions: typeof a.instructions === 'string' ? a.instructions : '' });
        d.onCreated?.(g);
        return ok(`Created the group "${g.name}" with ${g.memberIds.length} members (rule: ${g.rule}). It is in the roster under Groups; tell the user they can talk there.`);
      }),
    },
    {
      name: 'list_groups',
      description: 'The group chats that exist: name, members, lead and responder rule.',
      params: {},
      handler: guard(() => {
        const rows = d.groups.list();
        if (!rows.length) return ok('No groups yet.');
        return ok(rows.map((g) => `- ${g.name}: ${g.memberIds.map((id) => d.resolveBlob(id)?.name ?? id).join(', ')} (lead ${d.resolveBlob(g.leadId)?.name ?? g.leadId}, ${g.rule})`).join('\n'));
      }),
    },
  ];
}
