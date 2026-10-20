// Per-client tokens for `kora mcp --team`. Only the sha256 of a token is stored; the plaintext exists once, in the
// create reply. A token is 24 random bytes (192 bits), so an unsalted fast hash is the right tool (nothing to brute force).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { blobsStoreDir } from '../home';
import type { TokenRecord } from './types';

export const TOKEN_PREFIX = 'kbo_';
export const MAX_ACTIVE_TOKENS = 20;
export const MAX_NAME = 40;

export function outsideDir(): string { return path.join(blobsStoreDir(), 'outside'); }

interface Stored extends TokenRecord { hash: string }

export const hashToken = (t: string): string => crypto.createHash('sha256').update(t).digest('hex');
const pub = ({ hash: _h, ...r }: Stored): TokenRecord => r;

export type VerifyResult = { ok: true; record: TokenRecord } | { ok: false; reason: 'unknown' | 'revoked'; record?: TokenRecord };

export class TokenStore {
  private rows: Stored[] = [];
  private mtime = -1;
  constructor(private readonly dir: string = outsideDir(), private readonly now: () => number = Date.now) {}

  private get file(): string { return path.join(this.dir, 'tokens.json'); }

  /** Re-read when another process (or a test) changed the file: revocation must be immediate everywhere. */
  private load(): void {
    let m = 0;
    try { m = fs.statSync(this.file).mtimeMs; } catch { this.rows = []; this.mtime = -1; return; }
    if (m === this.mtime) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.rows = Array.isArray(j?.tokens) ? j.tokens.filter((r: any) => r && typeof r.id === 'string' && typeof r.hash === 'string') : [];
    } catch { this.rows = []; }
    this.mtime = m;
  }
  private save(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, tokens: this.rows }, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { this.mtime = fs.statSync(this.file).mtimeMs; } catch { this.mtime = -1; }
  }

  list(): TokenRecord[] { this.load(); return this.rows.map(pub).sort((a, b) => b.createdAt - a.createdAt); }

  create(rawName: string): { ok: true; record: TokenRecord; token: string } | { ok: false; message: string } {
    this.load();
    const name = rawName.replace(/\s+/g, ' ').trim();
    if (!name) return { ok: false, message: 'Give this client a name (for example "Claude Desktop").' };
    if (name.length > MAX_NAME) return { ok: false, message: `Names are at most ${MAX_NAME} characters.` };
    const active = this.rows.filter((r) => r.revokedAt === null);
    if (active.some((r) => r.name.toLowerCase() === name.toLowerCase())) return { ok: false, message: `A token named "${name}" already exists. Revoke it or pick another name.` };
    if (active.length >= MAX_ACTIVE_TOKENS) return { ok: false, message: `You already have ${MAX_ACTIVE_TOKENS} active tokens. Revoke one first.` };
    const token = TOKEN_PREFIX + crypto.randomBytes(24).toString('base64url');
    const row: Stored = { id: `tok_${crypto.randomBytes(6).toString('hex')}`, name, createdAt: this.now(), lastUsedAt: null, revokedAt: null, suffix: token.slice(-4), hash: hashToken(token) };
    this.rows.push(row);
    this.save();
    return { ok: true, record: pub(row), token };
  }

  revoke(id: string): boolean {
    this.load();
    const r = this.rows.find((x) => x.id === id);
    if (!r || r.revokedAt !== null) return false;
    r.revokedAt = this.now();
    this.save();
    return true;
  }

  verify(token: string): VerifyResult {
    this.load();
    if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX) || token.length > 200) return { ok: false, reason: 'unknown' };
    const h = Buffer.from(hashToken(token), 'hex');
    const r = this.rows.find((x) => { const b = Buffer.from(x.hash, 'hex'); return b.length === h.length && crypto.timingSafeEqual(b, h); });
    if (!r) return { ok: false, reason: 'unknown' };
    if (r.revokedAt !== null) return { ok: false, reason: 'revoked', record: pub(r) };
    return { ok: true, record: pub(r) };
  }

  /** Stamp last use (at most once a minute: this is a display field, not worth a write per call). */
  touch(id: string): void {
    const r = this.rows.find((x) => x.id === id);
    if (!r) return;
    const t = this.now();
    if (r.lastUsedAt !== null && t - r.lastUsedAt < 60_000) return;
    r.lastUsedAt = t;
    try { this.save(); } catch { /* display only */ }
  }
}
