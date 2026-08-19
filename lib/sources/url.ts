// lib/sources/url.ts
//
// Public-URL source: fetches a page via lib/sources/net/safe-fetch.ts's
// SSRF-guarded client (see that module's header for the actual protection
// logic -- deliberately not summarized/shortened here per the task
// instructions) and extracts its main readable content, discarding
// navigation/ads/footers so retrieval quality isn't degraded by
// boilerplate HTML. This module owns none of the SSRF logic itself -- it
// only calls safeFetch() and never reaches for `fetch`/`http`/`https`
// directly, so there is exactly one place in the codebase that makes an
// outbound request to a user-supplied host.

import "server-only";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { safeFetch } from "./net/safe-fetch";
import { SourceError } from "./errors";
import type { NormalizedDocument } from "./types";

const URL_FETCH_TIMEOUT_MS = 10_000;
const URL_MAX_CONTENT_BYTES = 10 * 1024 * 1024; // 10MB, see safe-fetch.ts's module header

/** Imports one public URL: fetch (SSRF-guarded) -> extract main content -> normalize. `sourceRef` on the result is the FINAL url after redirects (what should be re-fetched on "Refresh"), not necessarily what the user typed. */
export async function importUrlDocument(inputUrl: string): Promise<NormalizedDocument> {
  const result = await safeFetch(inputUrl, { timeoutMs: URL_FETCH_TIMEOUT_MS, maxBytes: URL_MAX_CONTENT_BYTES });

  if (result.status < 200 || result.status >= 300) {
    throw new SourceError({
      source: "url",
      kind: "upstream_error",
      message: `unexpected status ${result.status} fetching ${result.finalUrl}`,
      userMessage: `Страница вернула ошибку (HTTP ${result.status}).`,
    });
  }

  const contentType = String(result.headers["content-type"] ?? "");
  // Decoded as UTF-8 unconditionally -- a known, acceptable MVP
  // limitation: pages served in legacy encodings (e.g.
  // windows-1251/ISO-8859-1) without declaring/being UTF-8 will extract
  // with mojibake. Detecting and transcoding every charset a page might
  // declare is out of scope for this MVP; flagged in README.
  const bodyText = result.body.toString("utf-8");

  const looksLikeHtml =
    contentType.includes("html") ||
    /^\s*<!doctype html/i.test(bodyText) ||
    /^\s*<html[\s>]/i.test(bodyText);

  let title: string;
  let text: string;
  if (looksLikeHtml) {
    ({ title, text } = extractMainContent(bodyText, result.finalUrl));
  } else {
    // Plain text/markdown response (content-type text/plain, text/markdown,
    // or anything else that didn't look like HTML) -- use as-is.
    title = result.finalUrl;
    text = bodyText.trim();
  }

  if (!text.trim()) {
    throw new SourceError({
      source: "url",
      kind: "empty_content",
      message: `no extractable text at ${result.finalUrl}`,
      userMessage: "Не удалось извлечь текстовое содержимое со страницы.",
    });
  }

  return { title: title || result.finalUrl, text: text.trim(), sourceType: "url", sourceRef: result.finalUrl };
}

function extractMainContent(html: string, url: string): { title: string; text: string } {
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();
  if (article?.textContent && article.textContent.trim().length > 0) {
    return { title: article.title?.trim() || url, text: article.textContent.trim() };
  }
  // Readability found nothing "article-shaped" (common for e.g. app
  // shells, docs index/landing pages) -- fall back to a crude
  // script/style-stripped text dump of <body> rather than failing the
  // whole import outright.
  const doc = dom.window.document;
  doc.querySelectorAll("script, style, noscript, nav, footer").forEach((el) => el.remove());
  const fallbackText = (doc.body?.textContent ?? "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title: doc.title?.trim() || url, text: fallbackText };
}
