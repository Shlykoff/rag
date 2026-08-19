// lib/sources/net/ip-guard.ts
//
// Pure IP-range classification, no I/O -- this is what makes the SSRF
// protection unit-testable without any real network/DNS calls (see
// lib/sources/net/__tests__/ip-guard.test.ts). Built on Node's built-in
// `net.BlockList` (available since Node 15) rather than a hand-rolled
// CIDR bit-mask implementation: BlockList is maintained by Node core,
// exercised by Node's own test suite, and gets IPv4/IPv6 parsing edge
// cases (leading zeros, compressed "::" forms, etc.) right without adding
// a third-party dependency for something this security-sensitive.
//
// This module is the single source of truth for "is this address safe to
// connect to" -- lib/sources/net/safe-fetch.ts calls it from inside the
// `lookup` function it hands to Node's http/https client, so the exact
// same check that decides "allowed" is also what resolves the address the
// socket actually connects to (see that module's header for why that
// matters).

import { BlockList, isIPv4, isIPv6 } from "node:net";

/**
 * Every range CLAUDE.md requires blocking (127.0.0.0/8, 10.0.0.0/8,
 * 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 -- which includes
 * 169.254.169.254, the AWS/GCP/Azure metadata address), plus two
 * additional ranges that are the same *category* of risk and are standard
 * SSRF-guard hygiene even though the spec didn't enumerate them by number:
 *   - 0.0.0.0/8 ("this network" / unspecified address -- some services
 *     bind here and it's routable to "localhost" on many stacks)
 *   - 100.64.0.0/10 (carrier-grade NAT / "shared address space", RFC 6598
 *     -- used internally by some cloud providers, same risk profile as the
 *     RFC1918 ranges above)
 */
const BLOCKED_IPV4_RANGES: ReadonlyArray<{ address: string; prefix: number }> = [
  { address: "127.0.0.0", prefix: 8 }, // loopback
  { address: "10.0.0.0", prefix: 8 }, // RFC1918 private
  { address: "172.16.0.0", prefix: 12 }, // RFC1918 private
  { address: "192.168.0.0", prefix: 16 }, // RFC1918 private
  { address: "169.254.0.0", prefix: 16 }, // link-local, includes 169.254.169.254 cloud metadata
  { address: "0.0.0.0", prefix: 8 }, // "this network" / unspecified
  { address: "100.64.0.0", prefix: 10 }, // carrier-grade NAT (RFC6598)
];

/**
 * IPv6 equivalents -- a hostname the user pastes can resolve to an AAAA
 * record even for an otherwise-ordinary-looking domain, and checking only
 * the IPv4 ranges above would miss that path entirely.
 */
const BLOCKED_IPV6_RANGES: ReadonlyArray<{ address: string; prefix: number }> = [
  { address: "::1", prefix: 128 }, // loopback
  { address: "fe80::", prefix: 10 }, // link-local
  { address: "fc00::", prefix: 7 }, // unique local (RFC4193)
  { address: "::", prefix: 128 }, // unspecified
];

function buildBlockList(): BlockList {
  const list = new BlockList();
  for (const range of BLOCKED_IPV4_RANGES) {
    list.addSubnet(range.address, range.prefix, "ipv4");
    // Also block the IPv4-mapped IPv6 form of the same range
    // (::ffff:a.b.c.d). BlockList treats "ipv4" and "ipv6" subnets as
    // entirely separate checks -- it does NOT unwrap an IPv4-mapped IPv6
    // address into its IPv4 form before matching. Without this, a
    // resolver/socket that hands back "::ffff:169.254.169.254" instead of
    // plain "169.254.169.254" (which happens in dual-stack environments)
    // would sail straight through every rule above.
    list.addSubnet(`::ffff:${range.address}`, 96 + range.prefix, "ipv6");
  }
  for (const range of BLOCKED_IPV6_RANGES) {
    list.addSubnet(range.address, range.prefix, "ipv6");
  }
  return list;
}

const blockList = buildBlockList();

/**
 * True if `address` is inside any blocked private/loopback/link-local
 * range, OR is not a syntactically valid IPv4/IPv6 literal at all --
 * fail closed: anything this function can't confidently classify as safe
 * is treated as unsafe, never the other way around.
 */
export function isBlockedAddress(address: string): boolean {
  if (isIPv4(address)) return blockList.check(address, "ipv4");
  if (isIPv6(address)) return blockList.check(address, "ipv6");
  return true;
}

/**
 * Strips the square brackets WHATWG `URL` always wraps around an IPv6
 * literal host, e.g. `new URL("http://[::1]/").hostname === "[::1]"` (NOT
 * `"::1"`). This matters everywhere in this module and in safe-fetch.ts
 * that a hostname is handed to something IP-literal-aware:
 *
 *   - `node:net`'s `isIP()`/`isIPv6()` do NOT recognize a bracketed string
 *     as an IP at all (`isIP("[::1]") === 0`), so `isBlockedAddress()`
 *     above would silently fall through its "not a valid literal" branch
 *     for every IPv6 host unless the brackets are stripped first.
 *   - `node:dns`'s `dns.lookup()` cannot parse a bracketed string either
 *     and fails with ENOTFOUND -- which used to accidentally "block" every
 *     IPv6 literal (private AND public) by DNS failure rather than by
 *     actual classification. That's the bug this helper fixes.
 *
 * Per the WHATWG URL spec, `[` and `]` can only ever be the first and last
 * characters of an IPv6 hostname (never appear elsewhere, never appear for
 * an IPv4 literal or a domain name), so unconditionally stripping a
 * leading `[`/trailing `]` is safe for every hostname shape this function
 * will ever see -- it is a no-op for IPv4 literals and domain names.
 */
export function stripIpv6Brackets(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "");
}
