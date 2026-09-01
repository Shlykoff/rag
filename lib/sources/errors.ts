// lib/sources/errors.ts
//
// Mirrors lib/ai/errors.ts's AIProviderError pattern: every source adapter
// (manual-upload/notion/url/google-drive) catches whatever vendor-specific
// error it gets (Notion SDK errors, googleapis errors, raw Node
// http/dns errors, our own SSRF rejections...) and re-throws it as one
// SourceError shape here. API routes (lib/sources/http-error.ts) then only
// ever branch on SourceError.kind, never on a source-specific error class.

export type SourceType = "manual_upload" | "notion" | "url" | "google_drive";

export type SourceErrorKind =
  | "invalid_input" // malformed URL/id/file, bad request shape
  | "unsupported_file_type"
  | "too_large"
  | "empty_content" // fetched successfully but produced no extractable text
  | "ssrf_blocked" // blocked scheme, private/link-local IP, or a redirect into one
  | "timeout"
  | "unauthorized" // missing/invalid stored credential, or the source rejected it
  | "not_shared" // resource exists (or might) but isn't shared with the integration/service account
  | "not_found"
  | "upstream_error" // the source responded with an unexpected error we can't classify further
  | "unknown";

export interface SourceErrorInit {
  source: SourceType;
  kind: SourceErrorKind;
  /** Internal/log message -- may include vendor error details, never shown to end users. */
  message: string;
  /**
   * Short, user-facing message (Russian, matching the rest of the product
   * copy) that explains *what to do*, not just that something failed --
   * especially for "not_shared", the most common real-world failure mode
   * for both Notion and Google Drive (user forgot to click Share/Invite on
   * the integration or service account).
   */
  userMessage: string;
  status?: number;
  cause?: unknown;
}

export class SourceError extends Error {
  readonly source: SourceType;
  readonly kind: SourceErrorKind;
  readonly userMessage: string;
  readonly status?: number;
  override readonly cause?: unknown;

  constructor(init: SourceErrorInit) {
    super(init.message);
    this.name = "SourceError";
    this.source = init.source;
    this.kind = init.kind;
    this.userMessage = init.userMessage;
    this.status = init.status;
    this.cause = init.cause;
  }
}

/** Best-effort, no-dependency status/code extraction for logging only -- deliberately shallow (one level), unlike a full vendor-SDK error which can nest an entire outgoing request (headers included) arbitrarily deep. */
function extractStatusForLog(err: Error): number | string | undefined {
  const rec = err as unknown as Record<string, unknown>;
  if (typeof rec.status === "number") return rec.status;
  if (typeof rec.code === "string" || typeof rec.code === "number") return rec.code as number | string;
  return undefined;
}

/**
 * Redacts an error before it is ever handed to `console.error`/a future
 * structured logger. `googleapis`/`gaxios` errors carry the FULL outgoing
 * HTTP request as `err.config` (headers included), and `google-auth-library`
 * sets `Authorization: Bearer <access-token>` on that request itself, so a
 * raw Drive API error object logged as-is puts a live OAuth access token in
 * the logs. `SourceError.cause` wraps exactly that raw vendor error for
 * every source adapter (Notion SDK errors, googleapis errors, ...), so the
 * risk isn't specific to Google -- any adapter's vendor SDK could attach
 * similarly sensitive request/response data to a thrown error.
 *
 * `console.error(err)` on such an object only "looks" safe today because
 * Node's default `util.inspect` depth (2) happens to truncate before
 * reaching `err.cause.config.headers` -- that is NOT a safety guarantee: a
 * structured/JSON logger, `console.dir(err, { depth: null })`, or a future
 * `JSON.stringify(err)` would print the token in plaintext. Every
 * `console.error` call in lib/sources/ and app/api/sources/ that logs a
 * caught error (SourceError or not) MUST pass it through this function
 * first -- never the raw object, and never `.cause`.
 */
export function safeErrorForLog(err: unknown): Record<string, unknown> {
  if (err instanceof SourceError) {
    return {
      name: err.name,
      source: err.source,
      kind: err.kind,
      ...(err.status !== undefined ? { status: err.status } : {}),
      message: err.message,
    };
  }
  if (err instanceof Error) {
    const status = extractStatusForLog(err);
    return {
      name: err.name,
      message: err.message,
      ...(status !== undefined ? { status } : {}),
    };
  }
  return { message: typeof err === "string" ? err : "non-Error value thrown" };
}
