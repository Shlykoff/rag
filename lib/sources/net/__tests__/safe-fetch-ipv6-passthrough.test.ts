// lib/sources/net/__tests__/safe-fetch-ipv6-passthrough.test.ts
//
// Proves the other half of the IPv6-bracket fix that safe-fetch.test.ts's
// negative cases can't: that stripIpv6Brackets() doesn't just make blocked
// IPv6 literals correctly rejected, it also makes ALLOWED IPv6 literals
// actually connect -- i.e. the bracket-stripping is applied not only to the
// isIP()/isBlockedAddress() classification in validateUrl() but also to the
// `hostname` handed to the transport (see performOneRequest()'s
// `requestHostname` in safe-fetch.ts). Before that second fix, even an
// IPv6 URL that passed classification would still fail to connect, because
// Node's http/https client cannot dial a bracketed "[::1]" host (see
// safe-fetch.ts's comment on `requestHostname` for the exact
// ERR_INVALID_IP_ADDRESS Node throws otherwise).
//
// Why a mocked lib/sources/net/ip-guard.ts instead of the real one (same
// rationale as safe-fetch-redirects.test.ts, adapted for IPv6): the only
// IPv6 address this sandboxed test environment can reliably bind AND get a
// real TCP connection to is ::1 (loopback) -- but ::1 is, correctly,
// ALWAYS blocked by the real classifier. Mocking isBlockedAddress to allow
// it through here isolates exactly the thing this file needs to prove
// (bracket-stripped connect works end-to-end over a real socket) without
// needing real internet access to a genuinely public IPv6 address. The
// classifier's own correctness for real IPv6 ranges (including ::1 itself)
// is exhaustively covered, unmocked, in ip-guard.test.ts and
// safe-fetch.test.ts.

import { describe, expect, it, vi } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { safeFetch } from "../safe-fetch";

vi.mock("../ip-guard", async () => {
  const actual = await vi.importActual<typeof import("../ip-guard")>("../ip-guard");
  return {
    ...actual,
    // Real stripIpv6Brackets (needed by safe-fetch.ts itself), but every
    // address is treated as allowed -- see module header for why.
    isBlockedAddress: vi.fn(() => false),
  };
});

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "::1", () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("safeFetch: bracketed IPv6 literal actually connects once allowed (real socket, mocked guard)", () => {
  it("fetches successfully from a bracketed IPv6 URL (http://[::1]:PORT/)", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello over ipv6");
    });
    const port = await listen(server);
    try {
      const result = await safeFetch(`http://[::1]:${port}/`);
      expect(result.status).toBe(200);
      expect(result.body.toString("utf-8")).toBe("hello over ipv6");
      // finalUrl is built from the same URL object safeFetch validated --
      // still bracketed, as any well-formed IPv6 URL must be.
      expect(result.finalUrl).toBe(`http://[::1]:${port}/`);
    } finally {
      await close(server);
    }
  });
});
