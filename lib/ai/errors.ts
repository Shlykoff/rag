// lib/ai/errors.ts
//
// Every AI-provider adapter (openai/anthropic/voyage/gemini) throws
// different error shapes for the same underlying situation (rate limited,
// upstream 5xx, bad request, network failure). Business logic outside
// lib/ai/ must never branch on `err instanceof OpenAI.APIError` or similar
// -- it only ever sees `AIProviderError`, normalized here. This is what
// lets the API route show one consistent message to the user regardless of
// which AI_PROVIDER is active.

/** Coarse classification used to decide retry behavior and pick a user-facing message. */
export type AIErrorKind =
  | "rate_limited" // 429
  | "server_error" // 5xx
  | "invalid_request" // 4xx other than 429 (bad input, auth, etc.)
  | "network" // request never got a response (timeout, DNS, connection reset)
  // The signed-in user has no active AI provider configured (or its
  // credential row is missing) -- see lib/ai/index.ts's getAIProviders().
  // Thrown directly by lib/ai/index.ts, NEVER produced by
  // normalizeProviderError() below (a vendor SDK never reports this --
  // it's an app-level "nothing to call yet" state, not a failed call).
  // retryable is always false and status/cause are always undefined for
  // this kind, since the request never reached a vendor SDK at all.
  | "no_credentials"
  | "unknown";

export interface AIProviderErrorInit {
  provider: string;
  kind: AIErrorKind;
  /** Internal/log message -- may include vendor error details, never shown to end users. */
  message: string;
  /** Short, provider-agnostic message safe to surface to the end user (in Russian, matching the rest of the product copy). */
  userMessage: string;
  /** Whether an automatic retry is appropriate (429/5xx/network). 4xx "invalid request" and unknown errors are not retried. */
  retryable: boolean;
  status?: number;
  cause?: unknown;
}

export class AIProviderError extends Error {
  readonly provider: string;
  readonly kind: AIErrorKind;
  readonly userMessage: string;
  readonly retryable: boolean;
  readonly status?: number;
  override readonly cause?: unknown;

  constructor(init: AIProviderErrorInit) {
    super(init.message);
    this.name = "AIProviderError";
    this.provider = init.provider;
    this.kind = init.kind;
    this.userMessage = init.userMessage;
    this.retryable = init.retryable;
    this.status = init.status;
    this.cause = init.cause;
  }
}

/** Duck-types the common `status`/`statusCode`/`response.status` fields used by the OpenAI SDK, the AI SDK's APICallError, and the Voyage SDK's VoyageAIError. */
function extractStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const rec = err as Record<string, unknown>;
  if (typeof rec.status === "number") return rec.status;
  if (typeof rec.statusCode === "number") return rec.statusCode;
  const response = rec.response;
  if (
    typeof response === "object" &&
    response !== null &&
    typeof (response as Record<string, unknown>).status === "number"
  ) {
    return (response as Record<string, unknown>).status as number;
  }
  return undefined;
}

/** The AI SDK's APICallError already ships its own retryable classification (429/5xx vs 4xx) -- when present, trust it as a hint rather than re-deriving from status alone. */
function extractIsRetryableHint(err: unknown): boolean | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const v = (err as Record<string, unknown>).isRetryable;
  return typeof v === "boolean" ? v : undefined;
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Best-effort detection of a network-level failure (no HTTP response at all): Node's fetch throws a TypeError wrapping a `cause` with an `errno`/`code` for DNS/connection failures, and AbortError for timeouts. */
function looksLikeNetworkError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const rec = err as Record<string, unknown>;
  if (rec.name === "AbortError") return true;
  if ("errno" in rec || "code" in rec) return true;
  if (rec.cause && typeof rec.cause === "object") return true;
  return false;
}

/**
 * Normalizes any error thrown by a vendor SDK (or by the AI SDK's
 * provider-agnostic wrapper around it) into a single AIProviderError shape.
 * Pure function of its inputs (no I/O), so it's fully unit-testable with
 * fake error objects -- see lib/ai/__tests__/errors.test.ts.
 */
export function normalizeProviderError(
  err: unknown,
  provider: string
): AIProviderError {
  if (err instanceof AIProviderError) return err;

  const status = extractStatus(err);
  const retryableHint = extractIsRetryableHint(err);
  const message = extractMessage(err);

  if (status === 429) {
    return new AIProviderError({
      provider,
      kind: "rate_limited",
      status,
      retryable: true,
      cause: err,
      message: `${provider} API rate limited (429): ${message}`,
      userMessage:
        "Сервис перегружен, попробуйте через несколько секунд.",
    });
  }

  if (status !== undefined && status >= 500) {
    return new AIProviderError({
      provider,
      kind: "server_error",
      status,
      retryable: true,
      cause: err,
      message: `${provider} API server error (${status}): ${message}`,
      userMessage:
        "Сервис временно недоступен, попробуйте ещё раз через некоторое время.",
    });
  }

  if (status !== undefined && status >= 400) {
    return new AIProviderError({
      provider,
      kind: "invalid_request",
      status,
      retryable: false,
      cause: err,
      message: `${provider} API request error (${status}): ${message}`,
      userMessage: "Не удалось обработать запрос к AI-провайдеру.",
    });
  }

  if (looksLikeNetworkError(err)) {
    return new AIProviderError({
      provider,
      kind: "network",
      retryable: true,
      cause: err,
      message: `${provider} network error: ${message}`,
      userMessage:
        "Не удалось связаться с AI-провайдером, попробуйте ещё раз.",
    });
  }

  // No HTTP status could be extracted, but the SDK's own classification
  // says this is/isn't retryable -- honor that rather than guessing.
  if (retryableHint !== undefined) {
    return new AIProviderError({
      provider,
      kind: retryableHint ? "server_error" : "unknown",
      retryable: retryableHint,
      cause: err,
      message: `${provider} error (unclassified status, sdk retryable=${retryableHint}): ${message}`,
      userMessage: retryableHint
        ? "Сервис временно недоступен, попробуйте ещё раз через некоторое время."
        : "Произошла непредвиденная ошибка. Попробуйте позже.",
    });
  }

  return new AIProviderError({
    provider,
    kind: "unknown",
    retryable: false,
    cause: err,
    message: `${provider} unknown error: ${message}`,
    userMessage: "Произошла непредвиденная ошибка. Попробуйте позже.",
  });
}
