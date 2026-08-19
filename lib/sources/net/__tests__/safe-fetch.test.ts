// lib/sources/net/__tests__/safe-fetch.test.ts
//
// End-to-end tests of safeFetch() against the REAL, unmocked
// lib/sources/net/ip-guard.ts classifier -- no network access required or
// attempted: scheme rejection happens before any DNS lookup, and
// resolving a literal IP address (127.0.0.1, 169.254.169.254, ...) via
// Node's dns.lookup is a local/synchronous-ish operation that never
// reaches the network for an already-literal address, so these run fast
// and deterministically in any environment (including one with no
// internet access, like this one).
//
// The manual-redirect-following MECHANISM (each hop re-validated, not
// just the first URL) is covered separately in
// safe-fetch-redirects.test.ts, which needs a mocked ip-guard + real local
// HTTP servers to simulate "hop 1 allowed, hop 2 blocked" without
// depending on real internet access -- see that file's header for why.

import { describe, expect, it } from "vitest";
import { safeFetch } from "../safe-fetch";
import { SourceError } from "../../errors";

describe("safeFetch: scheme allowlist (rejected before any network access)", () => {
  it.each(["file:///etc/passwd", "ftp://example.com/file", "gopher://example.com", "data:text/plain,hello", "javascript:alert(1)"])(
    "rejects %s",
    async (url) => {
      await expect(safeFetch(url)).rejects.toMatchObject({ kind: "ssrf_blocked" });
      await expect(safeFetch(url)).rejects.toBeInstanceOf(SourceError);
    }
  );

  it("rejects an unparseable URL", async () => {
    await expect(safeFetch("not a url at all")).rejects.toMatchObject({ kind: "ssrf_blocked" });
  });
});

describe("safeFetch: private/link-local addresses rejected before the request leaves (real guard, real dns.lookup, no network reached)", () => {
  it("rejects a request to a loopback literal (127.0.0.1)", async () => {
    // Port doesn't matter -- guardedLookup rejects the connection before a
    // socket is ever opened, regardless of whether anything is listening.
    await expect(safeFetch("http://127.0.0.1:65535/")).rejects.toBeInstanceOf(SourceError);
    await expect(safeFetch("http://127.0.0.1:65535/")).rejects.toMatchObject({ kind: "ssrf_blocked" });
  });

  it("rejects a request to the cloud metadata address (169.254.169.254)", async () => {
    await expect(safeFetch("http://169.254.169.254/latest/meta-data/")).rejects.toMatchObject({ kind: "ssrf_blocked" });
  });

  it("rejects an RFC1918 private address (10.x)", async () => {
    await expect(safeFetch("http://10.0.0.5/")).rejects.toMatchObject({ kind: "ssrf_blocked" });
  });

  it("rejects a request to a private address even over https", async () => {
    await expect(safeFetch("https://192.168.1.1/")).rejects.toMatchObject({ kind: "ssrf_blocked" });
  });
}, 15_000);

describe("safeFetch: IPv6-literal hosts (regression coverage for the bracket-stripping bug)", () => {
  // WHATWG `URL` always brackets an IPv6 host ("[::1]", never "::1"). Before
  // stripIpv6Brackets() existed, validateUrl()'s literal-IP fast path never
  // matched any of these (isIP("[::1]") === 0), so the request fell through
  // to guardedLookup/dns.lookup("[::1]", ...) -- which can't parse a
  // bracketed string and fails with a generic ENOTFOUND. That ACCIDENTALLY
  // rejected every one of these (private AND public IPv6 alike) but for the
  // wrong reason: a DNS-parse failure classified as `kind: "upstream_error"`,
  // not a deliberate SSRF classification. Every case below asserts the
  // SPECIFIC failure mode -- `kind: "ssrf_blocked"` with a message that
  // names the actual unbracketed literal and the word "blocked" -- proving
  // the rejection is real classification, not an incidental ENOTFOUND. If
  // the bracket-stripping fix regressed, these would still reject, but with
  // `kind: "upstream_error"` / a message mentioning ENOTFOUND instead --
  // which is exactly the distinction `.toMatchObject({ kind: ... })` below
  // is designed to catch.
  it.each([
    ["http://[::1]/", "::1", "IPv6 loopback"],
    ["http://[fe80::1]/", "fe80::1", "IPv6 link-local"],
    ["http://[::ffff:169.254.169.254]/", "::ffff:169.254.169.254", "IPv4-mapped cloud metadata address"],
    ["http://[fd00:ec2::254]/", "fd00:ec2::254", "AWS IPv6 metadata address (unique-local fc00::/7)"],
  ])("blocks %s (%s) via real classification, not an ENOTFOUND side effect", async (url, literal) => {
    let caught: unknown;
    try {
      await safeFetch(url);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SourceError);
    const sourceError = caught as SourceError;
    // The specific kind a real SSRF-guard classification produces --
    // `upstream_error`/`timeout` are what a DNS/network failure would
    // produce instead, so asserting this kind specifically is what proves
    // the block came from isBlockedAddress(), not from dns.lookup() choking
    // on a bracketed string it can't parse.
    expect(sourceError.kind).toBe("ssrf_blocked");
    // The internal message names the unbracketed literal that was actually
    // classified -- if brackets were still present here, this would fail,
    // which is exactly the regression this test exists to catch.
    expect(sourceError.message).toContain(literal);
    expect(sourceError.message).toContain("blocked literal IP");
    expect(sourceError.message).not.toMatch(/ENOTFOUND/i);
  });

  it("does NOT block a public IPv6 literal at the validateUrl() classification stage", async () => {
    // We can't assert "safeFetch resolves successfully" without real
    // internet access (unavailable/flaky in CI, see this file's header) or
    // an elaborate IPv6-loopback mock server (covered separately in
    // safe-fetch-ipv6-passthrough.test.ts, which proves the full
    // bracket-stripped connect actually works end-to-end against a real
    // socket). What we CAN assert deterministically here, with the real
    // unmocked guard: a well-known public IPv6 address is never classified
    // as blocked, i.e. the request fails (if it fails at all, e.g. no IPv6
    // route in this sandbox) for a network reason, never for
    // `kind: "ssrf_blocked"`.
    let caught: unknown;
    try {
      // Port 1 is deliberately not a real HTTP port -- this forces a fast
      // connection-level failure (ECONNREFUSED/EHOSTUNREACH/timeout)
      // instead of depending on a real HTTP server answering on :80,
      // without changing what's being proven: did it even get PAST
      // validateUrl()'s literal-IP check.
      await safeFetch("http://[2001:4860:4860::8888]:1/", { timeoutMs: 3_000 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SourceError);
    const sourceError = caught as SourceError;
    expect(sourceError.kind).not.toBe("ssrf_blocked");
  }, 10_000);
});
