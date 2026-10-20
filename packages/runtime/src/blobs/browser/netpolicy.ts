// Network policy of the blob browser (Phase 6.4): a blob's browser must never become a way into the user's own
// machine or LAN. Loopback, private ranges, link-local (cloud metadata lives at 169.254.169.254), `*.local` and every
// DNS name that RESOLVES to one of those are refused, for navigations, redirect hops and subresource requests
// alike. A per-blob allowlist opens named local dev servers on purpose.
// Everything is pure except `makeNetGuard`, which takes an injected resolver so DNS rebinding is testable.
import dns from 'node:dns';
import net from 'node:net';

export type NetVerdict = { ok: true } | { ok: false; reason: string; code: 'private-ip' | 'private-name' | 'unresolvable' | 'scheme' | 'public-to-local' };

/** Parse a dotted IPv4 to 4 octets, or null. */
function v4(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

function isPrivateV4(o: number[]): boolean {
  const [a, b, c] = o;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||        // CGNAT
    (a === 169 && b === 254) ||                  // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||         // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) ||     // benchmarking
    a >= 224                                      // multicast, reserved, broadcast
  );
}

/** Expand an IPv6 literal (no brackets, no zone) into 8 hextets, or null. Handles `::` and an embedded dotted IPv4 tail. */
function v6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const pct = s.indexOf('%'); if (pct >= 0) s = s.slice(0, pct);
  if (!s.includes(':')) return null;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(':');
  const maybe4 = v4(s.slice(lastColon + 1));
  if (maybe4) { tail = [(maybe4[0] << 8) | maybe4[1], (maybe4[2] << 8) | maybe4[3]]; s = s.slice(0, lastColon + 1) + '0:0'; }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (p: string) => (p === '' ? [] : p.split(':').map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)));
  const head = parse(halves[0]); const rest = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...rest].some(Number.isNaN)) return null;
  let out: number[];
  if (halves.length === 2) { const fill = 8 - head.length - rest.length; if (fill < 1) return null; out = [...head, ...Array(fill).fill(0), ...rest]; }
  else out = head;
  if (out.length !== 8) return null;
  if (tail.length) { out[6] = tail[0]; out[7] = tail[1]; }
  return out;
}

/** True when `ip` (v4 or v6 literal, brackets tolerated) is loopback / private / link-local / otherwise not public. */
export function isPrivateIp(raw: string): boolean {
  const ip = raw.replace(/^\[|\]$/g, '');
  const a = v4(ip);
  if (a) return isPrivateV4(a);
  const h = v6(ip);
  if (!h) return false; // not an IP literal: not this function's business
  if (h.every((x) => x === 0)) return true;                                   // ::
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true;        // ::1
  const embedded = (hi: number, lo: number) => isPrivateV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return embedded(h[6], h[7]);   // ::ffff:a.b.c.d (mapped)
  if (h.slice(0, 6).every((x) => x === 0)) return embedded(h[6], h[7]);                       // ::a.b.c.d (compatible)
  if (h[0] === 0x64 && h[1] === 0xff9b) return embedded(h[6], h[7]);                          // 64:ff9b::/96 NAT64
  if (h[0] === 0x2002) return embedded(h[1], h[2]);                                           // 6to4 embeds a v4
  if ((h[0] & 0xfe00) === 0xfc00) return true;                                                // fc00::/7 unique local
  if ((h[0] & 0xffc0) === 0xfe80) return true;                                                // fe80::/10 link-local
  if ((h[0] & 0xffc0) === 0xfec0) return true;                                                // fec0::/10 site-local (deprecated)
  if ((h[0] & 0xff00) === 0xff00) return true;                                                // multicast
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true;                                        // documentation
  return false;
}

const PRIVATE_SUFFIXES = ['.local', '.localhost', '.localdomain', '.internal', '.home.arpa', '.lan', '.intranet', '.corp'];

/** Names that are private by spelling alone (no DNS needed). */
export function isPrivateName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h === 'broadcasthost' || h === 'ip6-localhost' || h === 'ip6-loopback') return true;
  if (!h.includes('.') && !net.isIP(h)) return true; // single-label names (printers, `nas`, `router`) are the LAN
  return PRIVATE_SUFFIXES.some((s) => h.endsWith(s));
}

export interface HostPort { host: string; port: string }
/** `host` of a URL as the policy sees it (lowercase, no brackets, no trailing dot) plus its effective port. */
export function hostPortOf(raw: string): HostPort | null {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    const port = u.port || (u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : '');
    return host ? { host, port } : null;
  } catch { return null; }
}

/** Allowlist entry: `localhost`, `127.0.0.1`, `localhost:5173`, `*.test`, `*.test:3000`, `[::1]:8080`. */
export function allowlistMatches(entries: readonly string[], hp: HostPort): boolean {
  for (const raw of entries) {
    const e = raw.trim().toLowerCase();
    if (!e) continue;
    let host = e; let port = '';
    const m = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(e);
    if (m) { host = m[1].replace(/^\[|\]$/g, ''); port = m[2] ?? ''; }
    if (port && port !== hp.port) continue;
    if (host === hp.host) return true;
    if (host.startsWith('*.') && hp.host.endsWith(host.slice(1))) return true;
  }
  return false;
}

export type Resolver = (host: string) => Promise<string[]>;

/** The system resolver: every address the name resolves to (A + AAAA). */
export const systemResolver: Resolver = async (host) => {
  const rows = await dns.promises.lookup(host, { all: true, verbatim: true });
  return rows.map((r) => r.address);
};

export interface NetGuardOptions {
  /** Called on every check (a live setting: the allowlist can change while the browser runs). */
  allowlist?: () => readonly string[];
  resolve?: Resolver;
  /** Positive DNS answers are reused this long (ms). The response tripwire (`checkRemoteIp`) covers the rest. Default 5000. */
  dnsTtlMs?: number;
}

export interface NetGuard {
  /** Decide whether a request to `url` may leave the browser. `fromUrl` is the page that makes a subresource request. */
  check(url: string, opts?: { fromUrl?: string; document?: boolean }): Promise<NetVerdict>;
  /** The address the browser actually connected to (CDP `Network.responseReceived.remoteIPAddress`). */
  checkRemoteIp(url: string, remoteIp: string | undefined): NetVerdict;
  /** Is this host explicitly allowed (allowlist) by the user? */
  allowed(url: string): boolean;
  clearCache(): void;
}

const refuse = (code: Extract<NetVerdict, { ok: false }>['code'], reason: string): NetVerdict => ({ ok: false, code, reason });
const HOW = 'The blob browser cannot open local or private-network addresses unless you allow that host in the blob\'s browser settings.';

export function makeNetGuard(o: NetGuardOptions = {}): NetGuard {
  const resolve = o.resolve ?? systemResolver;
  const ttl = o.dnsTtlMs ?? 5000;
  const cache = new Map<string, { at: number; addrs: string[] }>();
  const list = () => o.allowlist?.() ?? [];
  const allowed = (url: string) => { const hp = hostPortOf(url); return !!hp && allowlistMatches(list(), hp); };

  async function addrsOf(host: string): Promise<string[]> {
    const hit = cache.get(host);
    if (hit && Date.now() - hit.at < ttl) return hit.addrs;
    const addrs = await resolve(host);
    cache.set(host, { at: Date.now(), addrs });
    if (cache.size > 500) for (const k of cache.keys()) { cache.delete(k); if (cache.size < 250) break; }
    return addrs;
  }

  return {
    allowed,
    clearCache: () => cache.clear(),
    async check(url, opts = {}) {
      let u: URL;
      try { u = new URL(url); } catch { return refuse('scheme', 'invalid URL'); }
      // Non-network schemes the page legitimately uses (inline images, blobs, the blank page) never reach the network.
      if (u.protocol === 'about:' || u.protocol === 'data:' || u.protocol === 'blob:') return { ok: true };
      if (u.protocol === 'file:') return refuse('scheme', 'file:// is blocked');
      if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'ws:' && u.protocol !== 'wss:') return refuse('scheme', `${u.protocol} URLs are not allowed`);
      const hp = hostPortOf(url)!;
      const isIp = net.isIP(hp.host) !== 0;
      const literalPrivate = isIp && isPrivateIp(hp.host);
      const namePrivate = !isIp && isPrivateName(hp.host);
      let verdictPrivate: string | null = null;
      if (literalPrivate) verdictPrivate = `${hp.host} is a loopback/private-network address`;
      else if (namePrivate) verdictPrivate = `${hp.host} is a local network name`;
      else if (!isIp) {
        let addrs: string[];
        try { addrs = await addrsOf(hp.host); } catch { addrs = []; }
        // Unresolvable names fail closed only if they could be private; a plain NXDOMAIN just fails to load anyway.
        const bad = addrs.find((a) => isPrivateIp(a));
        if (bad) verdictPrivate = `${hp.host} resolves to the private address ${bad}`;
      }
      if (!verdictPrivate) return { ok: true };
      if (!allowlistMatches(list(), hp)) return refuse(literalPrivate ? 'private-ip' : namePrivate ? 'private-name' : 'private-ip', `${verdictPrivate}. ${HOW}`);
      // Allowlisted. A PUBLIC page still may not reach into the local network with scripts, images, frames or XHR:
      // that is exactly how a hostile site attacks the user's dev server. Navigations the agent makes on purpose are fine.
      if (opts.fromUrl && !opts.document) {
        const from = hostPortOf(opts.fromUrl);
        if (from && from.host !== hp.host) {
          const fromPrivate = net.isIP(from.host) ? isPrivateIp(from.host) : isPrivateName(from.host) || allowlistMatches(list(), from);
          if (!fromPrivate) return refuse('public-to-local', `a public page (${from.host}) tried to reach the local address ${hp.host}`);
        }
      }
      return { ok: true };
    },
    checkRemoteIp(url, remoteIp) {
      if (!remoteIp) return { ok: true };
      const ip = remoteIp.replace(/^\[|\]$/g, '');
      if (!isPrivateIp(ip)) return { ok: true };
      const hp = hostPortOf(url);
      if (hp && allowlistMatches(list(), hp)) return { ok: true };
      return refuse('private-ip', `${hp?.host ?? url} connected to the private address ${ip} (DNS changed between the check and the connection). ${HOW}`);
    },
  };
}
