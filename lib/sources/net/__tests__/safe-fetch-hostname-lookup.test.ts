// lib/sources/net/__tests__/safe-fetch-hostname-lookup.test.ts
//
// Proves safeFetch() actually establishes a REAL socket connection through
// guardedLookup() -- the custom Node `lookup` hook -- for a genuine
// hostname, not a literal IP. This is the exact path every real-world
// "Публичный URL" request takes (nobody types a bare IP literal into the
// source form), and it is the one path none of the other
// safe-fetch*.test.ts files exercise end-to-end:
//
//   - safe-fetch.test.ts only resolves literal IPs (127.0.0.1,
//     169.254.169.254, [::1], ...) -- and, per validateUrl()'s own comment
//     in safe-fetch.ts, Node's http/net internals skip the custom `lookup`
//     hook ENTIRELY for an already-literal-IP host. guardedLookup() never
//     runs for any of those tests.
//   - safe-fetch-redirects.test.ts uses 127.0.0.1 literals for both hops.
//   - safe-fetch-ipv6-passthrough.test.ts uses a bracketed "[::1]" literal.
//
// None of those calls the dns.lookup()-backed custom `lookup` callback that
// guardedLookup() implements -- so a callback-shape bug in guardedLookup()
// itself (the exact bug this file regression-tests) passed every existing
// test while making every real hostname-based request fail in production.
//
// Root cause this guards against: Node 20/22 default
// `net.getDefaultAutoSelectFamily() === true` (Happy Eyeballs, what this
// project's pinned Node version -- see package.json's `engines` /
// `.nvmrc` -- actually runs under). Under that default, `net.js` invokes a
// custom `lookup` hook with `options.all === true` and requires the MODERN
// array callback form: `callback(null, [{ address, family }, ...])`.
// guardedLookup() used to always reply in the legacy triple-arg form
// (`callback(null, address, family)`) regardless of `options.all`, which
// made Node's OWN internals throw `ERR_INVALID_IP_ADDRESS: Invalid IP
// address: undefined` for every hostname lookup -- surfacing to
// `safeFetch()` callers as a misleading `kind: "upstream_error"` (see
// lib/sources/net/safe-fetch.ts's `req.on("error", ...)` handler), never
// actually reaching the network. This test fails with exactly that
// behavior before the fix (assert on it below) and passes after it.
//
// Why "localhost" as the hostname, and why isBlockedAddress is mocked:
// `net.isIP("localhost") === 0` -- it is NOT a literal, so
// validateUrl()'s literal-IP fast path does not intercept it, and Node
// genuinely calls guardedLookup() for it, exactly like any real public
// domain would. `dns.lookup("localhost", { all: true })` reliably resolves
// (confirmed on this project's dev/test environment) to BOTH `::1` and
// `127.0.0.1` -- addresses this sandbox can actually bind and connect to
// without real internet access. Because both are loopback, the REAL
// isBlockedAddress() would (correctly) reject them, so -- exactly like
// safe-fetch-ipv6-passthrough.test.ts and safe-fetch-redirects.test.ts --
// this mocks isBlockedAddress to allow the resolved addresses through,
// isolating exactly what this file needs to prove (guardedLookup's
// callback SHAPE is correct end-to-end, over a real socket, under Node's
// real Happy-Eyeballs dialer) from the classifier's own correctness, which
// is covered exhaustively elsewhere, unmocked, in ip-guard.test.ts and
// safe-fetch.test.ts. `stripIpv6Brackets` is passed through to the REAL
// implementation (via `importActual`), same rationale as the other mocked
// tests in this directory.
//
// Both IPv4 and IPv6 loopback servers are started on the SAME port
// deliberately: `dns.lookup("localhost", { all: true })` can return `::1`
// and `127.0.0.1` in either order depending on the OS/resolver, and Node's
// Happy-Eyeballs dialer is free to attempt either first. Listening on only
// one family would make this test's pass/fail depend on which address
// family the local resolver/dialer happens to prefer today -- listening on
// both removes that flakiness while still exercising the exact real
// dial-multiple-addresses code path guardedLookup's array-form reply
// enables.

import { describe, expect, it, vi } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { safeFetch } from "../safe-fetch";
import { SourceError } from "../../errors";

vi.mock("../ip-guard", async () => {
  const actual = await vi.importActual<typeof import("../ip-guard")>("../ip-guard");
  return {
    ...actual,
    isBlockedAddress: vi.fn(() => false),
  };
});

function listenDualStack(handler: http.RequestListener): Promise<{ port: number; servers: http.Server[] }> {
  return new Promise((resolve, reject) => {
    const v4 = http.createServer(handler);
    v4.on("error", reject);
    v4.listen(0, "127.0.0.1", () => {
      const port = (v4.address() as AddressInfo).port;
      const v6 = http.createServer(handler);
      v6.on("error", reject);
      // Same port as the v4 listener -- different address family, so this
      // does not conflict.
      v6.listen(port, "::1", () => {
        resolve({ port, servers: [v4, v6] });
      });
    });
  });
}

function closeAll(servers: http.Server[]): Promise<void[]> {
  return Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
}

describe("safeFetch: real hostname resolution actually connects through guardedLookup (Node's real autoSelectFamily default)", () => {
  it("fetches successfully from a hostname URL (http://localhost:PORT/), not just a literal IP", async () => {
    const { port, servers } = await listenDualStack((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello via real hostname lookup");
    });
    try {
      // Before the fix: rejects with `kind: "upstream_error"` and a message
      // mentioning ERR_INVALID_IP_ADDRESS, thrown by Node's own net.js
      // internals reacting to guardedLookup's malformed callback shape --
      // never reaching this server at all. After the fix: a real response.
      const result = await safeFetch(`http://localhost:${port}/`);
      expect(result.status).toBe(200);
      expect(result.body.toString("utf-8")).toBe("hello via real hostname lookup");
      expect(result.finalUrl).toBe(`http://localhost:${port}/`);
    } finally {
      await closeAll(servers);
    }
  });

  it("still returns a SourceError (never a raw ERR_INVALID_IP_ADDRESS) even if guardedLookup regresses", async () => {
    // This does not depend on the bug being present -- it asserts
    // safeFetch()'s outer contract (always a SourceError, see safeFetch's
    // own doc comment) holds for hostname-based requests specifically,
    // which is the exact surface the bug corrupted (it leaked as
    // `kind: "upstream_error"`, technically still a SourceError, but for
    // entirely the wrong reason -- a real network condition never
    // occurred). A nonexistent local port makes this fail fast either way.
    let caught: unknown;
    try {
      await safeFetch("http://localhost:1/", { timeoutMs: 3_000 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SourceError);
  }, 10_000);
});
