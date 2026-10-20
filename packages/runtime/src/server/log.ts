// Append-only server log at ~/.kora/server.log. Never writes to stdout.
import fs from 'node:fs';
import path from 'node:path';
import { koraHome } from '../protocol/types';
import { redactSecrets } from '../util/redact';

let stream: fs.WriteStream | null = null;
export function logPath(): string { return path.join(koraHome(), 'server.log'); }
export function log(...parts: unknown[]): void {
  try {
    if (!stream) { fs.mkdirSync(koraHome(), { recursive: true, mode: 0o700 }); stream = fs.createWriteStream(logPath(), { flags: 'a', mode: 0o600 }); try { fs.chmodSync(logPath(), 0o600); } catch { /* best effort: an older log was created 0644 */ } }
    const line = parts.map((p) => (typeof p === 'string' ? p : p instanceof Error ? (p.stack || p.message) : JSON.stringify(p))).join(' ');
    // Credentials never reach the log, whoever passed them (an error message quoting a header, a pane screen…).
    stream.write(`${new Date().toISOString()} ${redactSecrets(line)}\n`);
  } catch { /* logging must never throw */ }
}
export function closeLog(): void { stream?.end(); stream = null; }
