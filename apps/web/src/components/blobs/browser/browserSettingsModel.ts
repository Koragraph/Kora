// Per-blob browser settings: which local dev servers the blob's browser may open, and whether pages may download files.
// Pure helpers (the form is BrowserSettings.tsx). The daemon re-validates nothing here: the host only matches these
// strings against the address, so a bad entry just never matches.

const HOST = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** `localhost`, `localhost:5173`, `127.0.0.1:3000`, `*.test` -> the cleaned entry; anything else -> null. */
export function parseLocalHost(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const m = /^(.*?)(?::(\d{1,5}))?$/.exec(s);
  if (!m) return null;
  const host = m[1] ?? "";
  const port = m[2];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return null;
  if (host.length === 0 || host.length > 253) return null;
  if (IPV4.test(host)) {
    if (host.split(".").some((n) => Number(n) > 255)) return null;
  } else if (!HOST.test(host)) return null;
  return port === undefined ? host : `${host}:${port}`;
}

/** The list with `entry` added once (case-insensitive), or the same list when it is already there. */
export function addLocalHost(list: ReadonlyArray<string>, entry: string): string[] {
  const seen = new Set(list.map((x) => x.toLowerCase()));
  return seen.has(entry.toLowerCase()) ? [...list] : [...list, entry];
}

export function removeLocalHost(list: ReadonlyArray<string>, entry: string): string[] {
  return list.filter((x) => x !== entry);
}

export const MAX_LOCAL_HOSTS = 20;
