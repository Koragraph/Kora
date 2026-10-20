// Dispatch for `kora blob-tools <kind> <verb>`.
import path from 'node:path';
import type { Verb } from './util';
import { ToolError } from './util';

export const KINDS: Record<string, Record<string, () => Verb>> = {
  xlsx: { read: () => require('./xlsx').read, write: () => require('./xlsx').write, edit: () => require('./xlsx').edit },
  docx: { read: () => require('./docx').read, write: () => require('./docx').write, edit: () => require('./docx').edit },
  pptx: { read: () => require('./pptx').read, write: () => require('./pptx').write },
  pdf: { read: () => require('./pdf').read, info: () => require('./pdf').info },
};

/** Run one verb. Never throws: a failure is `{ok:false, error}` (the agent reads it and fixes its input). */
export async function runDocTool(kind: string, verb: string, input: Record<string, any>, cwd = process.cwd()): Promise<Record<string, unknown>> {
  const k = KINDS[kind];
  if (!k) return { ok: false, error: `unknown tool "${kind}" (use ${Object.keys(KINDS).join(' | ')})` };
  const v = k[verb];
  if (!v) return { ok: false, error: `unknown verb "${verb}" for ${kind} (use ${Object.keys(k).join(' | ')})` };
  try { return await v()(input, cwd); }
  catch (e: any) {
    if (e instanceof ToolError) return { ok: false, error: e.message };
    const msg = String(e?.message ?? e);
    return { ok: false, error: /ENOENT/.test(msg) ? `file not found: ${msg.replace(/^.*?'(.*?)'.*$/, '$1')}` : msg.slice(0, 400) };
  }
}
void path;
