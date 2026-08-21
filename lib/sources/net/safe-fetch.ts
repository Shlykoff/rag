// lib/sources/net/safe-fetch.ts
//
// SSRF-safe HTTP GET, used exclusively by lib/sources/url.ts. This is the
// single most security-critical module in the project (a user-supplied
// URL that the SERVER fetches on their behalf is the textbook SSRF vector
// -- CLAUDE.md calls this out explicitly), so every requirement it must
// satisfy is enforced here in code, not left to caller discipline:
//
//   1. Only http/https schemes are ever dialed (no file://, ftp://,
//      data:, gopher://, ...) -- see validateUrl().
//
//   2. The domain is resolved BEFORE the request is allowed to leave, and
//      EVERY resolved address is checked against
//      lib/sources/net/ip-guard.ts's private/loopback/link-local ranges
//      (which explicitly include the cloud-metadata address
//      169.254.169.254) -- a hostname that resolves to ANY blocked
//      address is rejected outright, even if it also has a public one.
//      A URL whose host is ALREADY a literal IP (e.g.
//      "http://169.254.169.254/...") is checked directly in validateUrl(),
//      not via DNS at all -- Node's http/net internals skip the custom
//      `lookup` hook entirely for a literal-IP host (see the comment in
//      validateUrl() for how this was actually discovered), so relying on
//      guardedLookup alone would silently let the single most obvious
//      SSRF payload straight through.
//
//   3. That same resolution is what the actual TCP connection uses, via
//      Node's `lookup` request option (see guardedLookup below). There is
//      no separate "check the DNS answer, then let the HTTP client
//      re-resolve and connect on its own" step. Splitting those two would
//      reopen exactly the DNS-rebinding bypass this module exists to
//      close: a malicious/compromised DNS server can legitimately answer
//      one query with a public IP and the very next query (milliseconds
//      later, for the same hostname) with a private one, so if "the IP we
//      validated" and "the IP we connect to" come from two independent
//      DNS lookups, the validation step is provably bypassable. Here they
//      are the exact same lookup call -- guardedLookup both decides
//      "allowed?" and hands back the literal address Node dials.
//
//   4. Every redirect hop is followed MANUALLY (never handed to the HTTP
//      client's own auto-redirect-follow) and re-validated from scratch --
//      steps 1-3 all run again, in full, for the redirect target (see the
//      loop in safeFetch()). This is the classic gap in a lot of SSRF
//      guards in the wild: they check the URL the user typed, then let
//      the HTTP client silently follow a 302 straight into
//      "http://169.254.169.254/..." without ever re-checking anything.
//
//   5. A request-level timeout (per hop) and a response-body byte cap,
//      enforced by destroying the socket the instant the cap is exceeded
//      (not "download it all, then check Content-Length" -- a
//      Content-Length header can lie, or be absent entirely).

import * as http from "node:http";
import * as https from "node:https";
import * as dns from "node:dns";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { isBlockedAddress, stripIpv6Brackets } from "./ip-guard";
import { SourceError } from "../errors";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10MB
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export interface SafeFetchResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** The URL that actually served this response, after following any redirects -- what gets stored as `documents.source_ref` (see lib/sources/url.ts). */
  finalUrl: string;
}

function ssrfError(message: string, userMessage: string, cause?: unknown): SourceError {
  return new SourceError({ source: "url", kind: "ssrf_blocked", message, userMessage, cause });
}

/**
 * The `lookup` implementation handed to http.request/https.request. This
 * function IS the SSRF check, not a preamble to it (see module header,
 * point 3): it resolves every address for `hostname`, rejects the
 * connection outright the instant any of them is in a blocked range, and
 * otherwise hands back the validated address(es) for Node's HTTP client to
 * dial. `{ all: true }` (the fixed `dns.lookup` options passed below, not
 * to be confused with the caller-supplied `options.all` this function must
 * also respect -- see next paragraph) matters -- checking only the first
 * address a resolver happens to return would miss a private address served
 * alongside/after a public-looking one.
 *
 * CALLBACK SHAPE, and why this is the one part of this function that is
 * genuinely fiddly (this bit is a real, previously-shipped bug, not a
 * hypothetical): Node's own `net.js` calls this function with DIFFERENT
 * expectations for the callback depending on `options.all`, and gets to
 * choose that unilaterally per-call -- this function does not control it.
 * Since Node 20/22, `net.getDefaultAutoSelectFamily()` defaults to `true`
 * (Happy Eyeballs), and under that mode `net.js` invokes a custom `lookup`
 * hook with `options.all === true` and requires the MODERN array form:
 * `callback(null, [{ address, family }, ...])`. Replying in the legacy
 * triple-arg form (`callback(null, address, family)`) in that case is not
 * merely "less complete" -- Node's internals throw
 * `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined` while trying to
 * destructure a string as if it were an array, which surfaces to
 * safeFetch()'s caller as a misleading `kind: "upstream_error"`, for EVERY
 * hostname (this never affects a literal-IP URL, which skips this function
 * entirely -- see validateUrl()'s comment -- which is exactly why this had
 * shipped unnoticed: every test that connected over a real socket happened
 * to use a literal IP). See
 * lib/sources/net/__tests__/safe-fetch-hostname-lookup.test.ts for the
 * regression test that exercises this real end-to-end (real hostname, real
 * socket, real Node 22 autoSelectFamily default -- not a mocked lookup).
 */
function guardedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void
): void {
  // Defensive: `hostname` here is normally a plain domain name (Node never
  // calls this custom `lookup` for an already-literal IP host -- see
  // validateUrl()'s comment) so it should never arrive bracketed. Strip
  // brackets anyway so this function degrades safely instead of feeding
  // `dns.lookup()` a string it cannot parse (see stripIpv6Brackets's doc
  // comment for why a bracketed literal breaks dns.lookup with ENOTFOUND
  // rather than being correctly classified).
  const target = stripIpv6Brackets(hostname);
  // Always resolve with `{ all: true }` regardless of what the CALLER asked
  // for (see doc comment above) -- the SSRF check itself needs every
  // resolved address, every time, to be able to reject a hostname the
  // instant ANY of its records is private/link-local. What varies below is
  // only the SHAPE of the reply to `callback`, driven by the caller's own
  // `options.all`, never which addresses got checked.
  dns.lookup(target, { all: true }, (err, addresses: LookupAddress[]) => {
    // Node's callback type requires `address` even on the error path (it's
    // ignored by net.js whenever `err` is non-null, but `callback`'s TS
    // signature above -- copied from Node's own -- doesn't make it
    // optional); "" is the same placeholder the original implementation
    // used here.
    if (err) {
      callback(err, "");
      return;
    }
    if (addresses.length === 0) {
      callback(Object.assign(new Error(`no DNS records found for "${hostname}"`), { code: "ENOTFOUND" }), "");
      return;
    }
    // Reject outright if ANY resolved address is blocked (scans the FULL
    // list -- not just the address that will end up being dialed) -- see
    // this function's doc comment and module header point 2.
    const blocked = addresses.find((a) => isBlockedAddress(a.address));
    if (blocked) {
      callback(
        Object.assign(
          new Error(
            `SSRF guard: "${hostname}" resolves to ${blocked.address}, which is in a blocked private/loopback/link-local range`
          ),
          { code: "EBLOCKEDADDRESS" }
        ),
        ""
      );
      return;
    }
    if (options.all) {
      // Modern array form (see doc comment). Every entry here already
      // passed the SSRF check above -- Node's own Happy-Eyeballs dialer
      // races/tries these exactly as it would for an unguarded lookup, it
      // just never gets to see an address this module hasn't validated.
      callback(
        null,
        addresses.map((a) => ({ address: a.address, family: a.family }))
      );
      return;
    }
    // Legacy triple-arg form, for callers that didn't ask for `{ all:
    // true }` (e.g. autoSelectFamily disabled, or an older Node).
    const chosen = addresses[0];
    callback(null, chosen.address, chosen.family);
  });
}

function validateUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw ssrfError(`invalid URL: ${raw}`, "Некорректный URL.");
  }
  // Scheme allowlist (point 1): rejects file://, ftp://, data:, javascript:,
  // gopher://, and anything else outright, BEFORE any DNS lookup or
  // network I/O happens for this URL.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw ssrfError(
      `blocked scheme: ${url.protocol} (url: ${raw})`,
      "Разрешены только ссылки со схемой http:// или https://."
    );
  }
  // IMPORTANT, easy to miss: when the URL's host is ALREADY a literal IP
  // address (e.g. "http://169.254.169.254/..." or "http://[::1]/..."),
  // Node's http/net internals skip calling the custom `lookup` function
  // entirely (there's nothing to resolve) and connect to that literal
  // straight away -- confirmed empirically, this is not documented
  // prominently. That means guardedLookup below (point 3) NEVER runs for a
  // literal-IP URL, which would otherwise be a complete, trivial bypass of
  // this whole module for exactly the most obvious attack ("just put the
  // metadata IP directly in the URL, skip the hostname entirely"). This
  // check is what closes that gap: literal IP hosts are validated here,
  // synchronously, before any request is attempted.
  //
  // IPv6 gotcha (previously a real bug, not just a comment): WHATWG `URL`
  // ALWAYS wraps an IPv6 host in square brackets --
  // `new URL("http://[::1]/").hostname === "[::1]"`, never `"::1"`. Both
  // `isIP()` and `isBlockedAddress()` operate on bare IP literals and do
  // NOT recognize a bracketed string as one (`isIP("[::1]") === 0`), so
  // checking `url.hostname` directly here silently never matches any IPv6
  // literal -- this branch used to be dead code for every "http://[...]"
  // URL. `stripIpv6Brackets()` is what makes the classification actually
  // run for IPv6 (see its doc comment in ip-guard.ts for the full story,
  // including why the request used to fail with a misleading ENOTFOUND
  // instead of being deliberately blocked).
  const literalHost = stripIpv6Brackets(url.hostname);
  if (isIP(literalHost) && isBlockedAddress(literalHost)) {
    throw ssrfError(
      `blocked literal IP in URL: ${literalHost} (url: ${raw})`,
      "Этот адрес недоступен для импорта (приватная или локальная сеть)."
    );
  }
  return url;
}

function performOneRequest(
  url: URL,
  options: Required<SafeFetchOptions>
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    let settled = false;
    const settleReject = (err: SourceError) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const settleResolve = (value: { status: number; headers: http.IncomingHttpHeaders; body: Buffer }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    // WHATWG `URL` always brackets an IPv6 hostname ("[::1]"); Node's
    // http/https client wants the BARE literal in `hostname` (it adds the
    // brackets back itself for the `Host` header) and, more importantly,
    // treating "[::1]" as an opaque unresolved hostname is exactly what
    // caused the custom `lookup` (guardedLookup) to be invoked with a
    // bracketed string it couldn't pass to `dns.lookup()` -- see
    // validateUrl()'s and stripIpv6Brackets's comments. Stripping here is a
    // no-op for IPv4 literals and domain names.
    const requestHostname = stripIpv6Brackets(url.hostname);
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: requestHostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          "User-Agent": "rag-assistant-url-source/1.0 (+document ingestion)",
          Accept: "text/html,application/xhtml+xml,text/plain,text/markdown,*/*;q=0.5",
        },
        // The whole point of this module: pin DNS resolution AND the actual
        // socket connection to one validated lookup (see guardedLookup's
        // doc comment / module header point 3).
        lookup: guardedLookup,
        timeout: options.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;

        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > options.maxBytes) {
            // Abort mid-stream (point 5) -- do not wait for the response to
            // finish downloading before enforcing the cap.
            res.destroy();
            settleReject(
              new SourceError({
                source: "url",
                kind: "too_large",
                message: `response for ${url} exceeded ${options.maxBytes} bytes`,
                userMessage: `Страница превышает лимит размера (${Math.round(options.maxBytes / (1024 * 1024))}MB).`,
              })
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          settleResolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
        });
        res.on("error", (err) =>
          settleReject(
            new SourceError({
              source: "url",
              kind: "upstream_error",
              message: `response stream error for ${url}: ${err.message}`,
              userMessage: "Не удалось загрузить страницу.",
              cause: err,
            })
          )
        );
      }
    );

    req.on("timeout", () => {
      req.destroy();
      settleReject(
        new SourceError({
          source: "url",
          kind: "timeout",
          message: `request to ${url} timed out after ${options.timeoutMs}ms`,
          userMessage: "Превышено время ожидания ответа от страницы.",
        })
      );
    });

    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EBLOCKEDADDRESS") {
        settleReject(ssrfError(err.message, "Этот адрес недоступен для импорта (приватная или локальная сеть)."));
        return;
      }
      settleReject(
        new SourceError({
          source: "url",
          kind: "upstream_error",
          message: `request error for ${url}: ${err.message}`,
          userMessage: "Не удалось связаться со страницей.",
          cause: err,
        })
      );
    });

    req.end();
  });
}

/**
 * Fetches `inputUrl` with full SSRF protection (see module header) and
 * manual, per-hop-revalidated redirect following. Always rejects with a
 * SourceError (never a raw Node/DNS error) -- callers only ever need to
 * branch on SourceError.kind.
 */
export async function safeFetch(inputUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const options: Required<SafeFetchOptions> = {
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
    maxRedirects: opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
  };

  let currentUrl = validateUrl(inputUrl);

  for (let hop = 0; hop <= options.maxRedirects; hop++) {
    const { status, headers, body } = await performOneRequest(currentUrl, options);

    if (REDIRECT_STATUSES.has(status) && headers.location) {
      // Re-run validateUrl() (scheme check) AND go through
      // performOneRequest()'s guardedLookup (re-resolve + re-check the IP)
      // for the redirect target from scratch, exactly as for the original
      // URL -- see module header, point 4. `new URL(location, currentUrl)`
      // also correctly resolves a relative Location header against the
      // current URL.
      currentUrl = validateUrl(new URL(headers.location, currentUrl).toString());
      continue;
    }

    return { status, headers, body, finalUrl: currentUrl.toString() };
  }

  throw ssrfError(
    `too many redirects fetching ${inputUrl} (limit ${options.maxRedirects})`,
    "Слишком много перенаправлений при загрузке страницы."
  );
}
