// Hostname and address classification for privacy decisions. Conservative on purpose:
// calling a public address private is acceptable, the reverse would leak an internal host.

export function canonicalHostname(host: string): string {
  return host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.+$/, "");
}

type Ipv4 = readonly [number, number, number, number];

/** Strict dotted decimal only; "127.1" style short forms are plain hostnames here. */
const parseIpv4 = (host: string): Ipv4 | null => {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets as unknown as Ipv4;
};

const parseIpv6 = (host: string): number[] | null => {
  if (!host.includes(":")) return null;
  const halves = host.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head = groups(halves[0] ?? "");
  const tail = halves.length === 2 ? groups(halves[1] ?? "") : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  return fill >= 1 ? [...head, ...new Array<number>(fill).fill(0), ...tail] : null;
};

/** `::ffff:a.b.c.d` or `::ffff:hhhh:hhhh`. */
const parseMappedIpv4 = (host: string): Ipv4 | null => {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
  if (dotted) return parseIpv4(dotted[1]!);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (!hex) return null;
  const high = parseInt(hex[1]!, 16);
  const low = parseInt(hex[2]!, 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
};

const ipv4Of = (host: string): Ipv4 | null => parseIpv4(host) ?? parseMappedIpv4(host);

export function isLocalLoopbackHost(host: string): boolean {
  const name = canonicalHostname(host);
  if (name === "localhost" || name === "::1") return true;
  const ip = parseIpv4(name);
  return ip !== null && ip[0] === 127;
}

const isPrivateIpv4 = ([a, b]: Ipv4): boolean =>
  a === 0 ||
  a === 10 ||
  a === 127 ||
  (a === 100 && b >= 64 && b <= 127) ||
  (a === 172 && b >= 16 && b <= 31) ||
  (a === 192 && b === 168) ||
  (a === 169 && b === 254) ||
  (a === 198 && (b === 18 || b === 19));

export function isPrivateNetworkHost(host: string): boolean {
  const name = canonicalHostname(host);
  if (name === "::" || isLocalLoopbackHost(name)) return true;
  if (name.endsWith(".localhost") || name.endsWith(".local")) return true;
  if (name === "home.arpa" || name.endsWith(".home.arpa")) return true;
  // A single dotless label is an intranet name.
  if (!name.includes(".") && !name.includes(":")) return true;
  if (name.endsWith(".ts.net")) return true;

  const ip4 = ipv4Of(name);
  if (ip4 !== null) return isPrivateIpv4(ip4);

  const ip6 = parseIpv6(name);
  if (ip6 !== null) {
    const first = ip6[0]!;
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
}

const RESERVED_SUFFIXES = ["alt", "example", "internal", "invalid", "onion", "test"];

const isSpecialPurposeIpv4 = (ip: Ipv4): boolean => {
  const [a, b, c] = ip;
  return (
    isPrivateIpv4(ip) ||
    a >= 224 ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
};

/** Whether the first `bits` bits of the address equal those of `prefix` (whole groups, then a masked remainder). */
const inPrefix = (ip: readonly number[], prefix: readonly number[], bits: number): boolean => {
  const whole = Math.floor(bits / 16);
  for (let i = 0; i < whole; i++) if (ip[i] !== prefix[i]) return false;
  const rest = bits % 16;
  if (rest === 0) return true;
  const mask = (0xffff << (16 - rest)) & 0xffff;
  return ((ip[whole] ?? 0) & mask) === ((prefix[whole] ?? 0) & mask);
};

const isPublicIpv6 = (ip: readonly number[]): boolean => {
  // NAT64: public exactly when the embedded IPv4 is.
  if (inPrefix(ip, [0x64, 0xff9b, 0, 0, 0, 0], 96)) {
    const high = ip[6]!;
    const low = ip[7]!;
    return !isSpecialPurposeIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
  }
  // Only global unicast, 2000::/3.
  if (!inPrefix(ip, [0x2000], 3)) return false;
  if (inPrefix(ip, [0x2001, 0xdb8], 32)) return false;
  if (inPrefix(ip, [0x2002], 16)) return false;
  if (inPrefix(ip, [0x3fff], 20)) return false;
  if (inPrefix(ip, [0x2001], 23)) {
    const lastIsOneToThree = ip[7]! >= 1 && ip[7]! <= 3;
    const middleZero = ip.slice(2, 7).every((group) => group === 0);
    return (
      (ip[1] === 1 && middleZero && lastIsOneToThree) ||
      inPrefix(ip, [0x2001, 3], 32) ||
      inPrefix(ip, [0x2001, 4, 0x112], 48) ||
      inPrefix(ip, [0x2001, 0x20], 28) ||
      inPrefix(ip, [0x2001, 0x30], 28)
    );
  }
  return true;
};

/** Whether this host may be sent to a public favicon service. */
export function isPublicFaviconHost(host: string): boolean {
  // Repeated trailing dots can hide legacy numeric forms such as 127.1.
  if (host.endsWith("..")) return false;
  const name = canonicalHostname(host);
  if (isPrivateNetworkHost(name)) return false;
  if (RESERVED_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`))) {
    return false;
  }
  const ip4 = ipv4Of(name);
  if (ip4 !== null) return !isSpecialPurposeIpv4(ip4);
  if (!name.includes(":")) return true;
  const ip6 = parseIpv6(name);
  return ip6 !== null && isPublicIpv6(ip6);
}
