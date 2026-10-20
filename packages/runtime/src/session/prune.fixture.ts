// Real-shaped Claude Code transcript lines for the prune tests (shapes copied from a live ~/.claude/projects file).
import type { Entry } from './prune';

export const SID = '11111111-2222-3333-4444-555555555555';
let n = 0;
const uid = (): string => `u-${++n}`;
export const big = (label: string, chars = 6000): string => `${label}\n` + 'x'.repeat(chars);
export function prompt(text: string, extra: Entry = {}): Entry { return { parentUuid: null, isSidechain: false, type: 'user', sessionId: SID, uuid: uid(), timestamp: '2026-10-14T10:00:00Z', message: { role: 'user', content: text }, ...extra }; }
export function asst(blocks: any[]): Entry { return { parentUuid: null, isSidechain: false, type: 'assistant', sessionId: SID, uuid: uid(), message: { model: 'claude-sonnet-5-5', id: `msg_${n}`, type: 'message', role: 'assistant', content: blocks, usage: { input_tokens: 1 } } }; }
export const thinking = (): any => ({ type: 'thinking', thinking: '', signature: 'EqAICqgBCBEYAipAWRh4vdG1DwMaK6Qc' });
export const use = (id: string, name: string, input: any): any => ({ type: 'tool_use', id, name, input });
export function result(id: string, content: any, extra: Entry = {}, top: Entry = {}): Entry { return { parentUuid: null, isSidechain: false, type: 'user', sessionId: SID, uuid: uid(), message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content, ...extra }] }, toolUseResult: { stdout: 'structured copy' }, ...top }; }

/** A thread of `turns` prompts; each turn reads a file, runs a command, edits and fails once. Turn 1 is the oldest. */
export function thread(turns: number): Entry[] {
  const out: Entry[] = [{ type: 'last-prompt', sessionId: SID, lastPrompt: 'x' }, { type: 'attachment', sessionId: SID, uuid: uid(), attachment: { type: 'date' } }];
  for (let t = 1; t <= turns; t++) {
    out.push(prompt(t === turns ? 'now fix src/last.ts please' : `turn ${t}: look at src/f${t}.ts`));
    out.push(asst([thinking(), { type: 'text', text: `reading f${t}` }, use(`r${t}`, 'Read', { file_path: `/repo/src/f${t}.ts` })]));
    out.push(result(`r${t}`, [{ type: 'text', text: big(`file f${t}`) }]));
    out.push(asst([use(`b${t}`, 'Bash', { command: `npm test -- f${t}` })]));
    out.push(result(`b${t}`, big(`test output ${t}`, 9000)));
    out.push(asst([use(`e${t}`, 'Edit', { file_path: `/repo/src/f${t}.ts`, old_string: 'a', new_string: 'b' })]));
    out.push(result(`e${t}`, `The file /repo/src/f${t}.ts has been updated. ${'y'.repeat(2000)}`));
    out.push(asst([use(`x${t}`, 'Bash', { command: 'false' })]));
    out.push(result(`x${t}`, big('Exit code 1 stack trace', 4000), { is_error: true }));
    out.push(asst([{ type: 'text', text: `done ${t}` }]));
  }
  return out;
}
