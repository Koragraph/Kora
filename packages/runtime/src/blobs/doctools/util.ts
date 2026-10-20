// Shared bits of the `kora blob-tools` document tools: JSON-in/JSON-out, paths resolved against the caller's cwd.
import fs from 'node:fs';
import path from 'node:path';
import { expandTilde } from '../../util/os-roots';

export class ToolError extends Error {}

export function need<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null || (typeof v === 'string' && !v)) throw new ToolError(`missing "${what}"`);
  return v;
}

export function resolvePath(p: unknown, cwd = process.cwd()): string {
  const s = need(typeof p === 'string' ? p : undefined, 'path');
  return path.resolve(cwd, expandTilde(s));
}

/** Refuse to clobber a file unless the caller said `overwrite`. */
export function assertWritable(file: string, overwrite: unknown): void {
  if (fs.existsSync(file) && overwrite !== true) throw new ToolError(`${file} already exists. Pass "overwrite": true to replace it, or use the edit verb.`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

export type ToolResult = Record<string, unknown>;
export type Verb = (input: Record<string, any>, cwd: string) => Promise<ToolResult>;
