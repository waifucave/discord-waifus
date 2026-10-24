// TEMPORARY local port (Living cast L2) of winter's web address rules (winter-agent-sdk,
// packages/runtime/src/web/private-address.ts, MIT, ours), until `@yanlinglabs/winter-web` ships and
// replaces src/life/web/ behind the same interface. Node-only and stricter than the original: it
// parses IPv6 itself and looks inside every embedding of an IPv4 address.
//
// What counts as NOT the public internet (refused under the "deny" policy):
//   IPv4  0.0.0.0/8, 10/8, 100.64/10 (CGNAT, also Alibaba's metadata 100.100.100.200), 127/8,
//         169.254/16 (link-local, cloud metadata 169.254.169.254), 172.16/12, 192.0.0/24, 192.0.2/24,
//         192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4
//         (255.255.255.255 included)
//   IPv6  ::/128, ::1, ::ffff:0:0/96 (mapped), ::/96 (compatible), 64:ff9b::/96 and 64:ff9b:1::/48
//         (NAT64), 100::/64, 2001::/32 (Teredo), 2001:db8::/32, 2002::/16 (6to4), fc00::/7 (incl.
//         AWS's fd00:ec2::254 metadata), fe80::/10, fec0::/10, ff00::/8 — an embedded IPv4 address is
//         classified too, so `::ffff:127.0.0.1`, `64:ff9b::a9fe:a9fe` or a 6to4 prefix around 10.0.0.1
//         is private
//   names `localhost`, `*.localhost`, `local`, `*.local`, `*.internal` (GCP metadata.google.internal)
//   and every address of one of this host's own network interfaces (our dashboard/API port included).
//
// URL hosts are canonical before they get here: the WHATWG parser turns `http://2130706433/`,
// `0x7f.1` and `017700000001` into `127.0.0.1` and brackets/compresses IPv6.

import { isIP } from "node:net";
import os from "node:os";

export type AddressVerdict = { private: boolean; reason?: string };

const PUBLIC: AddressVerdict = { private: false };

function parseIPv4(text: string): number[] | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255) ? bytes : undefined;
}

/** 16 bytes of an IPv6 address (zone id dropped), or undefined. */
export function parseIPv6(input: string): number[] | undefined {
  let text = input.trim().toLowerCase();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  if (isIP(text) !== 6) return undefined;
  let tailBytes: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (!v4) return undefined;
    tailBytes = v4;
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const groups = (part: string) => (part === "" ? [] : part.split(":").map((g) => parseInt(g, 16)));
  const head = groups(halves[0]!);
  const back = halves.length === 2 ? groups(halves[1]!) : [];
  const fill = 8 - head.length - back.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return undefined;
  const all = [...head, ...new Array<number>(halves.length === 2 ? fill : 0).fill(0), ...back];
  if (all.length !== 8 || all.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return undefined;
  const bytes = all.flatMap((g) => [g >> 8, g & 0xff]);
  if (tailBytes.length === 4) bytes.splice(12, 4, ...tailBytes);
  return bytes;
}

function v4InRange(bytes: number[], base: [number, number, number, number], prefix: number): boolean {
  let remaining = prefix;
  for (let i = 0; i < 4 && remaining > 0; i += 1) {
    const bits = Math.min(8, remaining);
    const mask = (0xff << (8 - bits)) & 0xff;
    if ((bytes[i]! & mask) !== (base[i]! & mask)) return false;
    remaining -= bits;
  }
  return true;
}

const PRIVATE_V4: Array<[[number, number, number, number], number, string]> = [
  [[0, 0, 0, 0], 8, "unspecified"],
  [[10, 0, 0, 0], 8, "private"],
  [[100, 64, 0, 0], 10, "carrier-grade NAT"],
  [[127, 0, 0, 0], 8, "loopback"],
  [[169, 254, 0, 0], 16, "link-local"],
  [[172, 16, 0, 0], 12, "private"],
  [[192, 0, 0, 0], 24, "reserved"],
  [[192, 0, 2, 0], 24, "documentation"],
  [[192, 88, 99, 0], 24, "relay"],
  [[192, 168, 0, 0], 16, "private"],
  [[198, 18, 0, 0], 15, "benchmarking"],
  [[198, 51, 100, 0], 24, "documentation"],
  [[203, 0, 113, 0], 24, "documentation"],
  [[224, 0, 0, 0], 4, "multicast"],
  [[240, 0, 0, 0], 4, "reserved"]
];

export function classifyIPv4Bytes(bytes: number[]): AddressVerdict {
  for (const [base, prefix, reason] of PRIVATE_V4) if (v4InRange(bytes, base, prefix)) return { private: true, reason };
  return PUBLIC;
}

function v6Prefix(bytes: number[], prefixHex: number[], bits: number): boolean {
  let remaining = bits;
  for (let i = 0; remaining > 0; i += 1) {
    const take = Math.min(8, remaining);
    const mask = (0xff << (8 - take)) & 0xff;
    if ((bytes[i]! & mask) !== ((prefixHex[i] ?? 0) & mask)) return false;
    remaining -= take;
  }
  return true;
}

export function classifyIPv6Bytes(bytes: number[]): AddressVerdict {
  const allZeroUntil = (end: number) => bytes.slice(0, end).every((b) => b === 0);
  const embedded = (offset: number) => classifyIPv4Bytes(bytes.slice(offset, offset + 4));
  if (bytes.every((b) => b === 0)) return { private: true, reason: "unspecified" };
  if (allZeroUntil(15) && bytes[15] === 1) return { private: true, reason: "loopback" };
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible): the embedded IPv4 decides, and either form is
  // refused outright when it embeds anything private.
  if (allZeroUntil(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    const v4 = embedded(12);
    return v4.private ? { private: true, reason: `IPv4-mapped ${v4.reason}` } : PUBLIC;
  }
  if (allZeroUntil(12)) return { private: true, reason: "IPv4-compatible" };
  // NAT64 well-known (64:ff9b::/96) and local-use (64:ff9b:1::/48): the IPv4 address is the last 32 bits.
  if (v6Prefix(bytes, [0x00, 0x64, 0xff, 0x9b], 32)) {
    const v4 = embedded(12);
    return v4.private ? { private: true, reason: `NAT64 ${v4.reason}` } : PUBLIC;
  }
  if (v6Prefix(bytes, [0x01, 0x00], 64) && allZeroUntil(0)) return { private: true, reason: "discard" };
  // 6to4 (2002::/16): bytes 2..5 carry the IPv4 address.
  if (v6Prefix(bytes, [0x20, 0x02], 16)) {
    const v4 = embedded(2);
    return v4.private ? { private: true, reason: `6to4 ${v4.reason}` } : { private: true, reason: "6to4" };
  }
  // Teredo (2001::/32): the client's IPv4 is the last 32 bits, inverted. Refused as a tunnel.
  if (v6Prefix(bytes, [0x20, 0x01, 0x00, 0x00], 32)) return { private: true, reason: "Teredo" };
  if (v6Prefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)) return { private: true, reason: "documentation" };
  if (v6Prefix(bytes, [0xfc], 7)) return { private: true, reason: "unique-local" };
  if (v6Prefix(bytes, [0xfe, 0x80], 10)) return { private: true, reason: "link-local" };
  if (v6Prefix(bytes, [0xfe, 0xc0], 10)) return { private: true, reason: "site-local" };
  if (v6Prefix(bytes, [0xff], 8)) return { private: true, reason: "multicast" };
  return PUBLIC;
}

/** One of this host's own interface addresses (normalized), cached briefly. */
let localCache: { at: number; addresses: Set<string> } | undefined;
function localInterfaceAddresses(): Set<string> {
  const now = Date.now();
  if (localCache && now - localCache.at < 60_000) return localCache.addresses;
  const addresses = new Set<string>();
  try {
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries ?? []) addresses.add(normalizeAddress(entry.address) ?? entry.address);
    }
  } catch {
    // no interface list: the range rules still apply
  }
  localCache = { at: now, addresses };
  return addresses;
}

/** A canonical text form of an IP literal (IPv6 expanded to 8 groups), or undefined. */
export function normalizeAddress(address: string): string | undefined {
  const v4 = parseIPv4(address);
  if (v4) return v4.join(".");
  const v6 = parseIPv6(address);
  if (!v6) return undefined;
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((v6[i]! << 8) | v6[i + 1]!).toString(16));
  return groups.join(":");
}

/** Classifies an IP literal. Unparseable input is private (fail closed). */
export function classifyAddress(address: string): AddressVerdict {
  const v4 = parseIPv4(address);
  const verdict = v4 ? classifyIPv4Bytes(v4) : (() => {
    const v6 = parseIPv6(address);
    return v6 ? classifyIPv6Bytes(v6) : { private: true, reason: "not an address" };
  })();
  if (verdict.private) return verdict;
  const normalized = normalizeAddress(address);
  if (normalized && localInterfaceAddresses().has(normalized)) return { private: true, reason: "this host" };
  return PUBLIC;
}

/** A hostname that is private by name whatever it resolves to (undefined: decide by address). */
export function classifyReservedName(hostname: string): AddressVerdict | undefined {
  let host = hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "localhost" || host.endsWith(".localhost")) return { private: true, reason: "localhost" };
  if (host === "local" || host.endsWith(".local")) return { private: true, reason: "mDNS name" };
  if (host === "internal" || host.endsWith(".internal")) return { private: true, reason: "internal name" };
  return undefined;
}

/** The literal-or-name verdict for a URL hostname before any lookup (undefined: an ordinary DNS name). */
export function classifyHostLexically(hostname: string): AddressVerdict | undefined {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (isIP(bare) !== 0 || parseIPv4(bare)) return classifyAddress(bare);
  return classifyReservedName(hostname);
}
