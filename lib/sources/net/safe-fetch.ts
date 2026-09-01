// lib/sources/net/safe-fetch.ts
//
// SSRF-safe HTTP GET, used exclusively by lib/sources/url.ts. A user-supplied
// URL that the server fetches on their behalf is the textbook SSRF vector, so
// every requirement below is enforced here in code, not left to caller
// discipline:
//
//   1. Only http/https schemes are ever dialed (no file://, ftp://,
//      data:, gopher://, ...) -- see validateUrl().
//
//   2. The domain is resolved BEFORE the request is allowed to leave, and
//      EVERY resolved address is checked against
//      lib/sources/net/ip-guard.ts's private/loopback/link-local ranges
//      (including the cloud-metadata address 169.254.169.254) -- a
//      hostname that resolves to ANY blocked address is rejected outright,
//      even if it also has a public one. A URL whose host is ALREADY a
//      literal IP (e.g. "http://169.254.169.254/...") is checked directly
//      in validateUrl(), not via DNS at all -- Node's http/net internals
//      skip the custom `lookup` hook entirely for a literal-IP host, so
//      relying on guardedLookup alone would let the most obvious SSRF
//      payload straight through.
//
//   3. That same resolution is what the actual TCP connection uses, via
//      Node's `lookup` request option (see guardedLookup below). There is
//      no separate "check the DNS answer, then let the HTTP client
//      re-resolve and connect on its own" step: a malicious/compromised
//      DNS server can answer one query with a public IP and the next
//      query for the same hostname, moments later, with a private one
//      (DNS rebinding) -- if "the IP we validated" and "the IP we connect
//      to" came from two independent lookups, validation would be
//      bypassable. guardedLookup both decides "allowed?" and hands back
//      the literal address Node dials, so they are always the same lookup.
//
//   4. Every redirect hop is followed MANUALLY (never handed to the HTTP
//      client's own auto-redirect-follow) and re-validated from scratch --
//      steps 1-3 all run again, in full, for the redirect target (see the
//      loop in safeFetch()). This closes the common SSRF-guard gap of
//      checking only the URL the user typed and then letting the client
//      silently follow a redirect into a blocked address unchecked.
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
 * dial. Resolving with `{ all: true }` matters regardless of the caller's
 * own `options.all` -- checking only the first address a resolver returns
 * would miss a private address served alongside/after a public-looking one.
 *
 * CALLBACK SHAPE: Node's `net.js` calls this function with a DIFFERENT
 * expected callback shape depending on `options.all`, chosen unilaterally
 * by Node per call. Since Node 20/22, `net.getDefaultAutoSelectFamily()`
 * defaults to `true` (Happy Eyeballs), and under that mode `net.js` invokes
 * a custom `lookup` hook with `options.all === true` and requires the
 * MODERN array form: `callback(null, [{ address, family }, ...])`. Replying
 * in the legacy triple-arg form (`callback(null, address, family)`) in that
 * case makes Node's internals throw `ERR_INVALID_IP_ADDRESS` while trying
 * to destructure a string as an array, which surfaces to safeFetch()'s
 * caller as a misleading `kind: "upstream_error"` for every hostname (a
 * literal-IP URL never reaches this function at all -- see validateUrl()).
 * See lib/sources/net/__tests__/safe-fetch-hostname-lookup.test.ts for the
 * regression test (real hostname, real socket, real Node 22
 * autoSelectFamily default, not a mocked lookup).
 */
function guardedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void
): void {
  // Node never calls this custom `lookup` for an already-literal-IP host
  // (see validateUrl()), so `hostname` should never arrive bracketed --
  // strip anyway so this degrades safely instead of feeding `dns.lookup()`
  // a string it can't parse (see stripIpv6Brackets).
  const target = stripIpv6Brackets(hostname);
  // Always resolve with `{ all: true }` regardless of the caller's own
  // `options.all` (see doc comment) -- only the callback's reply SHAPE
  // varies with the caller's option, never which addresses get checked.
  dns.lookup(target, { all: true }, (err, addresses: LookupAddress[]) => {
    // `address` is required by the callback type even on the error path
    // (net.js ignores it once `err` is set); "" mirrors Node's own usage.
    if (err) {
      callback(err, "");
      return;
    }
    if (addresses.length === 0) {
      callback(Object.assign(new Error(`no DNS records found for "${hostname}"`), { code: "ENOTFOUND" }), "");
      return;
    }
    // Reject if ANY resolved address is blocked, not just the one that
    // would end up being dialed (see module header, point 2).
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
      // passed the SSRF check above.
      callback(
        null,
        addresses.map((a) => ({ address: a.address, family: a.family }))
      );
      return;
    }
    // Legacy triple-arg form, for callers not requesting `{ all: true }`.
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
  // gopher://, and anything else, before any DNS lookup or network I/O.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw ssrfError(
      `blocked scheme: ${url.protocol} (url: ${raw})`,
      "Разрешены только ссылки со схемой http:// или https://."
    );
  }
  // When the URL's host is ALREADY a literal IP (e.g.
  // "http://169.254.169.254/..." or "http://[::1]/..."), Node's http/net
  // internals skip calling the custom `lookup` function entirely (there's
  // nothing to resolve) and connect to that literal directly. That means
  // guardedLookup below (point 3) NEVER runs for a literal-IP URL, which
  // would otherwise be a trivial full bypass of this module ("put the
  // metadata IP directly in the URL, skip the hostname"). This check closes
  // that gap: literal IP hosts are validated here, synchronously, before
  // any request is attempted.
  //
  // WHATWG `URL` always wraps an IPv6 host in square brackets --
  // `new URL("http://[::1]/").hostname === "[::1]"`, never `"::1"`. Both
  // `isIP()` and `isBlockedAddress()` operate on bare IP literals and don't
  // recognize a bracketed string as one (`isIP("[::1]") === 0`), so
  // `stripIpv6Brackets()` must run before classification for any IPv6
  // literal to be checked at all (see its doc comment in ip-guard.ts).
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
    // http/https client wants the BARE literal in `hostname` (it re-adds
    // brackets itself for the `Host` header), and guardedLookup needs an
    // unbracketed string to pass to `dns.lookup()`. Stripping here is a
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
        // Pins DNS resolution AND the actual socket connection to one
        // validated lookup (see guardedLookup / module header point 3).
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
      // Re-run validateUrl() (scheme + literal-IP check) and go through
      // guardedLookup again (re-resolve + re-check) for the redirect
      // target, exactly as for the original URL (module header, point 4).
      // `new URL(location, currentUrl)` also resolves a relative Location
      // header against the current URL.
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
