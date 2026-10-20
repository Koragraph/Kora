// What a member sees on a group turn. Each member keeps its OWN provider session per group thread, so it already
// remembers what it said and was asked; what it lacks is what the OTHERS said since its last reply. So the context is
// "everything after my last message" (capped), not a fixed tail. Pure.
import type { GroupMessage, GroupProfile } from './types';

export const CONTEXT_MAX_CHARS = 6_000;
export const CONTEXT_MESSAGE_CLIP = 700;
export const CONTEXT_FIRST_TURN_MESSAGES = 12;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

/** Messages the member has not seen: everything after its own last reply (or the last few if it never spoke). */
export function unseenFor(blobId: string, transcript: readonly GroupMessage[], exceptSeq?: number): GroupMessage[] {
  const msgs = transcript.filter((m) => m.kind === 'message' && m.seq !== exceptSeq);
  let from = 0;
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].authorId === blobId) { from = i + 1; break; }
  if (from === 0 && msgs.length > CONTEXT_FIRST_TURN_MESSAGES) from = msgs.length - CONTEXT_FIRST_TURN_MESSAGES;
  return msgs.slice(from);
}

export function renderTranscript(msgs: readonly GroupMessage[], maxChars = CONTEXT_MAX_CHARS): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {   // newest first, so the cap drops the OLDEST
    const m = msgs[i];
    const line = `${m.authorName}${m.to.length ? '' : ''}: ${clip(m.text.replace(/\n{3,}/g, '\n\n').trim(), CONTEXT_MESSAGE_CLIP)}`;
    if (used + line.length > maxChars && lines.length) { lines.push('(earlier messages left out)'); break; }
    lines.push(line); used += line.length;
  }
  return lines.reverse().join('\n');
}

export interface MemberPromptInput {
  group: Pick<GroupProfile, 'name' | 'instructions' | 'workspace' | 'leadId'>;
  /** The member taking this turn. */
  self: { id: string; name: string };
  members: ReadonlyArray<{ id: string; name: string; title: string; chief: boolean }>;
  /** The message that triggered this turn. */
  trigger: GroupMessage;
  transcript: readonly GroupMessage[];
  depth: number;
  maxDepth: number;
}

/** The text sent to a member as its turn. Short, structured, and explicit that mentioning is not delegating. */
export function buildMemberPrompt(i: MemberPromptInput): string {
  const roster = i.members.map((m) => `${m.name}${m.chief ? ' (Chief)' : ''}${m.id === i.group.leadId ? ' (lead)' : ''}${m.title ? `, ${m.title}` : ''}`).join('; ');
  const unseen = renderTranscript(unseenFor(i.self.id, i.transcript, i.trigger.seq));
  const canHandOver = i.depth < i.maxDepth;
  return [
    `[Group chat "${i.group.name}". You are ${i.self.name}. Members: ${roster}.]`,
    ...(i.group.instructions.trim() ? [`Shared instructions for this group:\n${i.group.instructions.trim()}`] : []),
    `Shared folder (everyone can read and write here): ${i.group.workspace}`,
    'How a group works: everyone sees the conversation. Answer as yourself, briefly, and only the part that is yours. Do not repeat what a teammate already said.' +
      (canHandOver ? ' To invite a teammate to weigh in, @mention them by name; that only asks them to reply, it does not give them a task.' : ' Do not @mention anyone in this reply.') +
      ' You cannot assign work to teammates; only Kora delegates.' +
      // live QA #4: group answers dropped the links asked for and contradicted each other without saying so
      ' If the user asked for links or sources, put the real URL on every item in your own message. If you disagree with something a teammate said above, say so plainly and why ("I got X, Junip said Y; the source says ..."): never quietly give a different number or fact.',
    ...(unseen ? [`Since you last spoke:\n${unseen}`] : []),
    `${i.trigger.authorName} said${i.trigger.to.length > 1 ? ' (to several of you)' : ''}:\n${i.trigger.text}`,
  ].join('\n\n');
}
