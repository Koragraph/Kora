import { FAVICON_CAPTURED_AT_MAX, SITE_ICON_DATA_URL_MAX } from "@kora/contracts";

import { canonicalHostname, isLocalLoopbackHost } from "./browserTargetResolver";

export type BrowserFaviconEntry = {
  aliases?: ReadonlyArray<string>;
  capturedAt: number;
  dataUrl: string;
};

export const BROWSER_FAVICON_MAX_ENTRIES = 40;
export const BROWSER_FAVICON_MAX_ALIASES_PER_ENTRY = 4;

const MAX_KEY_LENGTH = 4096;
const MAX_ALIAS_LENGTH = 255;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const PNG_DATA_PREFIX = "data:image/png;base64,";
const BASE64_BODY = /^[a-z0-9+/]+={0,2}$/i;

const isWebProtocol = (protocol: string) => protocol === "http:" || protocol === "https:";
const defaultPort = (protocol: string) => (protocol === "https:" ? "443" : "80");
const bracketIfIpv6 = (hostInfo: string) => (hostInfo.includes(":") ? `[${hostInfo}]` : hostInfo);
const isLoopbackLike = (hostInfo: string) =>
  isLocalLoopbackHost(hostInfo) || hostInfo === "0.0.0.0";

function parseWebUrl(unparsed: string): URL | null {
  try {
    const address = new URL(unparsed);
    return isWebProtocol(address.protocol) ? address : null;
  } catch {
    return null;
  }
}

export function canCanonicalizeFaviconWithoutHost(address: string): boolean {
  const decoded = parseWebUrl(address);
  return decoded !== null && isLoopbackLike(canonicalHostname(decoded.hostname));
}

export function isValidFaviconCapturedAt(val: unknown): val is number {
  return (
    typeof val === "number" &&
    Number.isFinite(val) &&
    val >= 0 &&
    val <= FAVICON_CAPTURED_AT_MAX &&
    val <= Date.now() + MAX_CLOCK_SKEW_MS
  );
}

export function faviconKey(
  projectRefKey: string,
  address: string,
  hostLabel: string | null,
): string | null {
  if (!projectRefKey) return null;
  const decoded = parseWebUrl(address);
  if (!decoded) return null;
  const urlHost = canonicalHostname(decoded.hostname);
  const ownHost = hostLabel === null ? null : canonicalHostname(hostLabel);
  const hostInfo =
    isLoopbackLike(urlHost) || (ownHost !== null && ownHost !== "" && urlHost === ownHost)
      ? "localhost"
      : urlHost;
  const port = decoded.port || defaultPort(decoded.protocol);
  return `${projectRefKey} ${decoded.protocol}//${bracketIfIpv6(hostInfo)}:${port}`;
}

export function faviconStorageLocation(
  projectRefKey: string,
  address: string,
  hostLabel: string | null,
): { readonly aliases: ReadonlyArray<string>; readonly key: string } | null {
  const keyName = faviconKey(projectRefKey, address, hostLabel);
  if (keyName === null) return null;
  if (hostLabel === null) return { aliases: [], key: keyName };
  try {
    const ownHost = canonicalHostname(hostLabel);
    if (!ownHost) return { aliases: [], key: keyName };
    const urlHost = canonicalHostname(new URL(address).hostname);
    if (!isLoopbackLike(urlHost) && urlHost !== ownHost) return { aliases: [], key: keyName };
    return { aliases: isLoopbackLike(ownHost) ? [] : [ownHost], key: keyName };
  } catch {
    return { aliases: [], key: keyName };
  }
}

export function isStorableFaviconDataUrl(val: unknown): val is string {
  if (typeof val !== "string" || !val.startsWith(PNG_DATA_PREFIX)) return false;
  if (val.length > SITE_ICON_DATA_URL_MAX) return false;
  const body = val.slice(PNG_DATA_PREFIX.length);
  return body.length > 0 && body.length % 4 !== 1 && BASE64_BODY.test(body);
}

export function evictExcessFavicons(
  entriesByKey: Record<string, BrowserFaviconEntry>,
): Record<string, BrowserFaviconEntry> {
  const records = Object.entries(entriesByKey);
  if (records.length <= BROWSER_FAVICON_MAX_ENTRIES) return entriesByKey;
  records.sort(([, a], [, b]) => (b.capturedAt ?? 0) - (a.capturedAt ?? 0));
  return Object.fromEntries(records.slice(0, BROWSER_FAVICON_MAX_ENTRIES));
}

/** Old stores could hold a bare "local" host; those entries really meant localhost. */
function migrateKey(keyName: string): string | null {
  if (!keyName || keyName.length > MAX_KEY_LENGTH) return null;
  const space = keyName.indexOf(" ");
  if (space <= 0) return null;
  const scope = keyName.slice(0, space);
  const originUrl = parseWebUrl(keyName.slice(space + 1));
  if (!originUrl) return null;
  if (
    originUrl.pathname !== "/" ||
    originUrl.search ||
    originUrl.hash ||
    originUrl.username ||
    originUrl.password
  ) {
    return null;
  }
  if (canonicalHostname(originUrl.hostname) !== "local") return keyName;
  return `${scope} ${originUrl.protocol}//localhost:${originUrl.port || defaultPort(originUrl.protocol)}`;
}

function validAlias(val: unknown): val is string {
  if (typeof val !== "string" || val.length > MAX_ALIAS_LENGTH) return false;
  const canonical = canonicalHostname(val);
  if (!canonical || canonical !== val) return false;
  try {
    return canonicalHostname(new URL(`http://${bracketIfIpv6(val)}`).hostname) === val;
  } catch {
    return false;
  }
}

function cleanAliases(unparsed: unknown): string[] {
  if (!Array.isArray(unparsed)) return [];
  return [...new Set(unparsed.filter(validAlias))].slice(0, BROWSER_FAVICON_MAX_ALIASES_PER_ENTRY);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function migrateSavedFavicons(persistedState: unknown): {
  byKey: Record<string, BrowserFaviconEntry>;
} {
  const source = isRecord(persistedState) ? persistedState.byKey : undefined;
  if (!isRecord(source)) return { byKey: {} };

  const combined: Record<string, BrowserFaviconEntry> = {};
  for (const [rawKey, raw] of Object.entries(source)) {
    const keyName = migrateKey(rawKey);
    if (keyName === null || !isRecord(raw)) continue;
    if (!isStorableFaviconDataUrl(raw.dataUrl) || !isValidFaviconCapturedAt(raw.capturedAt)) {
      continue;
    }
    const incoming = {
      dataUrl: raw.dataUrl,
      capturedAt: raw.capturedAt,
      aliases: cleanAliases(raw.aliases),
    };
    const existing = combined[keyName];
    let winner = incoming;
    let aliases = incoming.aliases;
    if (existing) {
      const newer = incoming.capturedAt > existing.capturedAt ? incoming : existing;
      const older = newer === incoming ? existing : incoming;
      winner = newer as typeof incoming;
      aliases = [...new Set([...(newer.aliases ?? []), ...(older.aliases ?? [])])].slice(
        0,
        BROWSER_FAVICON_MAX_ALIASES_PER_ENTRY,
      );
    }
    combined[keyName] = {
      dataUrl: winner.dataUrl,
      capturedAt: winner.capturedAt,
      ...(aliases.length > 0 ? { aliases } : {}),
    };
  }
  return { byKey: evictExcessFavicons(combined) };
}
