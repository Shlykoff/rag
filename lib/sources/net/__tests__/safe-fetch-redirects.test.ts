// lib/sources/net/__tests__/safe-fetch-redirects.test.ts
//
// Proves the part of safeFetch() that safe-fetch.test.ts CAN'T: that every
// redirect hop is re-validated by the SSRF guard, not just the entry URL --
// the exact bug class called out in CLAUDE.md ("сервис проверяет только
// первый URL, а сам HTTP-клиент следует редиректу... без повторной
// проверки").
//
// Why this needs a mocked lib/sources/net/ip-guard.ts instead of the real
// one: to observe "hop 1 allowed, hop 2 (the redirect target) blocked" we
// need safeFetch to actually connect somewhere for hop 1 -- but every
// address this sandboxed test environment can bind AND that the real,
// unmocked classifier would allow through is, definitionally, not private
// (and testing against the real public internet would be flaky/unavailable
// here, and wouldn't let us control what the "blocked" answer even is).
// So: mock isBlockedAddress with a call-counted implementation (allow the
// 1st resolution, block every one after) and run BOTH hops against the
// same real local HTTP server on 127.0.0.1 -- this still proves the real
// mechanism (validateUrl()/isBlockedAddress is consulted again, over a
// real socket connect, for the redirect target -- not just once for the
// entry URL -- and safeFetch correctly aborts when that second call says
// "blocked") without needing two different real-world IP classes. Because
// the target here is a literal IP (127.0.0.1), this specifically exercises
// validateUrl()'s literal-IP fast path (see safe-fetch.ts) on both hops,
// which is the exact code path a literal-IP redirect target (e.g. a 302 to
// "http://169.254.169.254/...") would go through in production -- the
// hostname-based path (guardedLookup, for the DNS-rebinding case) is
// exercised for a real hostname by safe-fetch.test.ts. The classifier's OWN
// correctness against the real required ranges (127.0.0.1, 10.x,
// 169.254.169.254, ...) is exhaustively covered, unmocked, in
// ip-guard.test.ts and safe-fetch.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { safeFetch } from "../safe-fetch";
import { SourceError } from "../../errors";

let blockAfterNCalls = Infinity; // isBlockedAddress returns true starting from the (blockAfterNCalls + 1)-th call
let callCount = 0;

// Hoisted above the imports above by vitest's transform regardless of
// source order, so `safeFetch`'s own `import { isBlockedAddress,
// stripIpv6Brackets } from "./ip-guard"` resolves to this mock -- see
// module header for why a mocked guard (rather than the real one) is
// needed for this file specifically. `stripIpv6Brackets` is passed through
// to the REAL implementation (via `importActual`) -- only the
// allow/block DECISION is mocked here, not the (non-security-sensitive,
// pure string) bracket-stripping safeFetch.ts also depends on.
vi.mock("../ip-guard", async () => {
  const actual = await vi.importActual<typeof import("../ip-guard")>("../ip-guard");
  return {
    ...actual,
    isBlockedAddress: vi.fn(() => {
      callCount += 1;
      return callCount > blockAfterNCalls;
    }),
  };
});

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("safeFetch: redirect hops are individually re-validated", () => {
  afterEach(() => {
    callCount = 0;
    blockAfterNCalls = Infinity;
  });

  it("allows a plain (non-redirect) request when the guard allows it", async () => {
    blockAfterNCalls = Infinity; // never block
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello from the origin server");
    });
    const port = await listen(server);
    try {
      const result = await safeFetch(`http://127.0.0.1:${port}/`);
      expect(result.status).toBe(200);
      expect(result.body.toString("utf-8")).toBe("hello from the origin server");
      expect(result.finalUrl).toBe(`http://127.0.0.1:${port}/`);
    } finally {
      await close(server);
    }
  });

  it("follows a redirect when BOTH hops are allowed, landing on the final URL's content", async () => {
    blockAfterNCalls = Infinity;
    const server = http.createServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: "/final" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("final destination content");
    });
    const port = await listen(server);
    try {
      const result = await safeFetch(`http://127.0.0.1:${port}/start`);
      expect(result.status).toBe(200);
      expect(result.body.toString("utf-8")).toBe("final destination content");
      expect(result.finalUrl).toBe(`http://127.0.0.1:${port}/final`);
    } finally {
      await close(server);
    }
  });

  it("rejects when the REDIRECT TARGET resolves to a blocked address, even though the entry URL was allowed", async () => {
    // 1st guard call (entry URL's DNS resolution) -> allowed.
    // 2nd guard call (redirect target's DNS resolution) -> blocked.
    blockAfterNCalls = 1;
    const server = http.createServer((req, res) => {
      if (req.url === "/start") {
        // Redirects to the SAME server/address -- what changes between hop
        // 1 and hop 2 is purely the guard's answer (simulating an
        // attacker-controlled redirect target that would, in reality, be a
        // different, private address), which is exactly the scenario this
        // test needs to isolate: safeFetch must re-run the guard for hop 2
        // and honor a "now blocked" answer, not just check once and cache.
        res.writeHead(302, { location: "/private" });
        res.end();
        return;
      }
      // Should never be reached -- if it is, safeFetch failed to block the
      // second hop and actually followed the redirect through to here.
      res.writeHead(200);
      res.end("SHOULD NOT BE REACHED");
    });
    const port = await listen(server);
    try {
      await expect(safeFetch(`http://127.0.0.1:${port}/start`)).rejects.toBeInstanceOf(SourceError);
      // callCount is 2 after the rejection above already consumed both
      // guard calls -- re-run once more to assert the exact rejection kind
      // via a fresh pair of calls (1 allowed, 2nd blocked again).
      callCount = 0;
      await expect(safeFetch(`http://127.0.0.1:${port}/start`)).rejects.toMatchObject({ kind: "ssrf_blocked" });
    } finally {
      await close(server);
    }
  });

  it("enforces maxRedirects and does not loop forever on a redirect chain that never ends", async () => {
    blockAfterNCalls = Infinity; // every hop's address is "allowed" -- only maxRedirects should stop this
    const server = http.createServer((_req, res) => {
      res.writeHead(302, { location: "/loop" }); // redirects to itself, forever
      res.end();
    });
    const port = await listen(server);
    try {
      await expect(safeFetch(`http://127.0.0.1:${port}/loop`, { maxRedirects: 3 })).rejects.toMatchObject({
        kind: "ssrf_blocked",
      });
    } finally {
      await close(server);
    }
  });

  it("aborts mid-stream once the response exceeds maxBytes, without buffering the whole body", async () => {
    blockAfterNCalls = Infinity;
    const CHUNK = Buffer.alloc(1024, "x");
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      // Keep writing well past any reasonable maxBytes -- if safeFetch
      // didn't abort early, this handler (and the test) would hang/OOM.
      const interval = setInterval(() => {
        if (res.destroyed) {
          clearInterval(interval);
          return;
        }
        res.write(CHUNK);
      }, 1);
      res.on("close", () => clearInterval(interval));
    });
    const port = await listen(server);
    try {
      await expect(safeFetch(`http://127.0.0.1:${port}/`, { maxBytes: 4096 })).rejects.toMatchObject({ kind: "too_large" });
    } finally {
      await close(server);
    }
  });

  it("rejects with kind 'timeout' when the server never responds within timeoutMs", async () => {
    blockAfterNCalls = Infinity;
    const server = http.createServer(() => {
      // Never call res.end()/res.writeHead() -- simulates a hung upstream.
    });
    const port = await listen(server);
    try {
      await expect(safeFetch(`http://127.0.0.1:${port}/`, { timeoutMs: 100 })).rejects.toMatchObject({ kind: "timeout" });
    } finally {
      await close(server);
    }
  }, 10_000);
});
