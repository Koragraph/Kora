// Getting a team file from a pasted link. The URL and everything behind it is untrusted: https only, no credentials in
// the link, no local or private addresses (checked on the name AND on what it resolves to, at every redirect hop), a short
// timeout, a hard byte cap enforced while streaming, a text content type. GitHub "blob" pages are rewritten to raw.
// Known limit: DNS can change between our lookup and the connection (rebinding); the response is only ever parsed as
// data and never executed, so the worst case is reading a local text page, and the size/type checks bound that.
import dns from 'node:dns/promises';
import net from 'node:net';
import { TEAMFILE_MAX_BYTES } from './schema';

export const FETCH_TIMEOUT_MS = 10_000;
export const FETCH_MAX_REDIRECTS = 3;

export class TeamFetchError extends Error {
  constructor(readonly code: 'bad-url' | 'not-https' | 'private-host' | 'too-big' | 'timeout' | 'http' | 'type' | 'redirects' | 'network', message: string) { super(message); this.name = 'TeamFetchError'; }
}

export interface TeamFetchDeps {
  fetchImpl?: typeof fetch;
  /** Resolve a hostname to its addresses. */
  lookup?(host: string): Promise<string[]>;
  timeoutMs?: number;
  maxBytes?: number;
}

export function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === '::1' || x === '::') return true;
    if (x.startsWith('::ffff:')) return isPrivateAddress(x.slice(7));
    return /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff');
  }
  return true;   // not an address at all: treat as unsafe
}

/** Normalise a pasted link. Throws TeamFetchError. */
export function checkTeamUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new TeamFetchError('bad-url', 'That does not look like a link.'); }
  if (u.protocol !== 'https:') throw new TeamFetchError('not-https', 'Only https links can be imported.');
  if (u.username || u.password) throw new TeamFetchError('bad-url', 'Links with a login in them are not allowed.');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || (net.isIP(host) && isPrivateAddress(host))) {
    throw new TeamFetchError('private-host', 'That address is on your own network, so it cannot be imported from.');
  }
  if (!host.includes('.') && !net.isIP(host)) throw new TeamFetchError('private-host', 'That address is not a public website.');
  // github.com/<o>/<r>/blob/<ref>/<path> -> raw.githubusercontent.com/<o>/<r>/<ref>/<path>
  const gh = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(u.pathname);
  if (host === 'github.com' && gh) return new URL(`https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3]}`);
  return u;
}

async function assertPublic(u: URL, lookup: (h: string) => Promise<string[]>): Promise<void> {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return;                      // already checked in checkTeamUrl
  let addrs: string[];
  try { addrs = await lookup(host); } catch { throw new TeamFetchError('network', `Could not find ${host}.`); }
  if (!addrs.length || addrs.some(isPrivateAddress)) throw new TeamFetchError('private-host', 'That address is on your own network, so it cannot be imported from.');
}

const defaultLookup = async (h: string) => (await dns.lookup(h, { all: true })).map((r) => r.address);
const TEXT_TYPE = /^(?:text\/|application\/(?:x-)?(?:yaml|markdown|octet-stream|json)|$)/i;

/** Fetch the text of a team file. Never follows a redirect without re-checking it. */
export async function fetchTeamFile(rawUrl: string, deps: TeamFetchDeps = {}): Promise<{ text: string; url: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const lookup = deps.lookup ?? defaultLookup;
  const maxBytes = deps.maxBytes ?? TEAMFILE_MAX_BYTES;
  let url = checkTeamUrl(rawUrl);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? FETCH_TIMEOUT_MS);
  timer.unref?.();
  try {
    for (let hop = 0; hop <= FETCH_MAX_REDIRECTS; hop++) {
      await assertPublic(url, lookup);
      let res: Response;
      try {
        res = await fetchImpl(url, { redirect: 'manual', signal: ctl.signal, headers: { accept: 'text/markdown, text/plain, */*;q=0.1', 'user-agent': 'Kora-team-import' }, credentials: 'omit' } as RequestInit);
      } catch (e: any) {
        if (ctl.signal.aborted) throw new TeamFetchError('timeout', 'The link took too long to answer.');
        throw new TeamFetchError('network', `Could not reach the link (${String(e?.cause?.code ?? e?.message ?? e).slice(0, 80)}).`);
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new TeamFetchError('http', 'The link redirected nowhere.');
        if (hop === FETCH_MAX_REDIRECTS) throw new TeamFetchError('redirects', 'The link redirects too many times.');
        url = checkTeamUrl(new URL(loc, url).toString());   // a redirect to http / localhost / private is refused here
        continue;
      }
      if (!res.ok) throw new TeamFetchError('http', `The link answered ${res.status}.`);
      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
      if (!TEXT_TYPE.test(type)) throw new TeamFetchError('type', `That link is not a text file (${type}).`);
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > maxBytes) throw new TeamFetchError('too-big', 'That file is too big for a team file.');
      // stream with a cap: never trust content-length alone
      const chunks: Uint8Array[] = []; let size = 0;
      const reader = res.body?.getReader();
      if (!reader) return { text: '', url: url.toString() };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) { void reader.cancel().catch(() => {}); throw new TeamFetchError('too-big', 'That file is too big for a team file.'); }
          chunks.push(value);
        }
      } catch (e) {
        if (e instanceof TeamFetchError) throw e;
        if (ctl.signal.aborted) throw new TeamFetchError('timeout', 'The link took too long to answer.');
        throw new TeamFetchError('network', 'The download was interrupted.');
      }
      return { text: Buffer.concat(chunks).toString('utf8'), url: url.toString() };
    }
    throw new TeamFetchError('redirects', 'The link redirects too many times.');
  } finally { clearTimeout(timer); }
}
