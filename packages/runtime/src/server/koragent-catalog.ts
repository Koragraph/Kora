// The koragent backend's model catalog: what the installed Koragent can run, and which of it is free ($0).
// Replaces `opencode models opencode` for swarm.workerBackend = 'koragent' (swarm-setup.ts).
//
//   1. `koragent models --json [--free]` (NAMES.md). Accepted shapes: an array of ids, an array of
//      `{id|model, providerID?, cost?}`, or `{models: …}`; `--free` is passed first and dropped if Koragent rejects it.
//   2. Fallback while `--json` is missing (koragent 1.18.32 prints its help and exits 1 — see KORAGENT-INTEGRATION.md):
//      `koragent models --verbose`, which prints `<provider>/<model>` followed by that model's JSON (with `cost`).
// Free = cost.input and cost.output both 0 (or the `free` flag / a `:free` suffix when there is no cost).
// Async child with a timeout; never throws (null = Koragent could not say, and the caller keeps what it had).
import { execFile } from 'node:child_process';

export interface KoragentModel { id: string; free: boolean }

const TIMEOUT_MS = 30_000;

function run(bin: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: TIMEOUT_MS, encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, NO_COLOR: '1' } }, (err, stdout) => {
      resolve({ ok: !err, out: String(stdout || '') });
    }).stdin?.end();
  });
}

function costFree(cost: any): boolean | null {
  if (!cost || typeof cost !== 'object') return null;
  const i = Number(cost.input); const o = Number(cost.output);
  if (!Number.isFinite(i) && !Number.isFinite(o)) return null;
  return (Number.isFinite(i) ? i : 0) === 0 && (Number.isFinite(o) ? o : 0) === 0;
}

function modelOf(x: any): KoragentModel | null {
  if (typeof x === 'string') return x.includes('/') ? { id: x, free: /:free$/.test(x) } : null;
  if (!x || typeof x !== 'object') return null;
  let id = typeof x.id === 'string' ? x.id : typeof x.model === 'string' ? x.model : null;
  if (!id) return null;
  if (typeof x.providerID === 'string' && !id.startsWith(`${x.providerID}/`)) id = `${x.providerID}/${id}`;
  if (!id.includes('/')) return null;
  const free = typeof x.free === 'boolean' ? x.free : costFree(x.cost) ?? /:free$/.test(id);
  return { id, free };
}

/** Parse `koragent models --json` output; null when it is not JSON of a known shape. */
export function parseModelsJson(text: string): KoragentModel[] | null {
  let v: any;
  try { v = JSON.parse(text); } catch { return null; }
  const list = Array.isArray(v) ? v : Array.isArray(v?.models) ? v.models : v && typeof v === 'object' && !Array.isArray(v) && !('models' in v)
    ? Object.entries(v).map(([id, m]) => (m && typeof m === 'object' ? { ...(m as object), id: (m as any).id && String((m as any).id).includes('/') ? (m as any).id : id } : id))
    : null;
  if (!list) return null;
  const out: KoragentModel[] = [];
  for (const x of list) { const m = modelOf(x); if (m) out.push(m); }
  return out;
}

/** Parse `koragent models --verbose`: `<provider>/<model>` lines, each followed by a pretty-printed JSON object. */
export function parseModelsVerbose(text: string): KoragentModel[] {
  const out: KoragentModel[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const id = lines[i].trim();
    if (!/^[\w.@-]+\/\S+$/.test(id)) continue;
    let json = '';
    let j = i + 1;
    if (lines[j]?.trim() === '{') {
      let depth = 0;
      for (; j < lines.length; j++) {
        json += lines[j] + '\n';
        for (const ch of lines[j]) { if (ch === '{') depth++; else if (ch === '}') depth--; }
        if (depth === 0) break;
      }
      i = j;
    }
    let meta: any = null;
    try { meta = json ? JSON.parse(json) : null; } catch { meta = null; }
    out.push({ id, free: (meta && (typeof meta.free === 'boolean' ? meta.free : costFree(meta.cost))) ?? /:free$/.test(id) });
  }
  return out;
}

/** Every model the installed Koragent lists, with its free flag; null when Koragent could not answer. */
export async function koragentModelList(bin: string): Promise<KoragentModel[] | null> {
  for (const args of [['models', '--json', '--free'], ['models', '--json']]) {
    const r = await run(bin, args);
    if (!r.ok) continue;
    const parsed = parseModelsJson(r.out.trim());
    // `--free` honoured → every row is free even without a cost field.
    if (parsed) return args.includes('--free') ? parsed.map((m) => ({ ...m, free: true })) : parsed;
  }
  const v = await run(bin, ['models', '--verbose']);
  if (!v.ok) return null;
  const list = parseModelsVerbose(v.out);
  return list.length ? list : null;
}

/** The free ($0) model ids the installed Koragent can run; null when it could not say. */
export async function koragentFreeModels(bin: string): Promise<string[] | null> {
  const list = await koragentModelList(bin);
  return list ? list.filter((m) => m.free).map((m) => m.id) : null;
}
