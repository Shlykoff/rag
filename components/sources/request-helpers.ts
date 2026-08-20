// components/sources/request-helpers.ts
//
// Shared fetch-and-normalize-the-response logic for every form under
// components/sources/ (upload/Notion/URL/Google Drive/credentials) and
// components/sources/DocumentCard.tsx's Refresh button. Every
// app/api/sources/* route uses the same response shapes for the unhappy
// paths (401 unauthorized, 429 rate_limited with a message + retryAfterMs,
// and a SourceError-derived { error, message } for everything else -- see
// lib/sources/http-error.ts) -- this is the one place that maps all of
// them to a single discriminated result so each form component only has
// to branch on `result.kind`, not re-derive status-code handling itself.

export interface SourceRequestSuccess<T> {
  ok: true;
  data: T;
}

export interface SourceRequestFailure {
  ok: false;
  kind: "unauthorized" | "rate_limited" | "not_found" | "error";
  message: string;
  retryAfterMs?: number;
}

export type SourceRequestResult<T> = SourceRequestSuccess<T> | SourceRequestFailure;

interface ErrorBody {
  error?: string;
  message?: string;
  details?: unknown;
  retryAfterMs?: number;
}

async function normalizeResponse<T>(response: Response): Promise<SourceRequestResult<T>> {
  if (response.status === 401) {
    return { ok: false, kind: "unauthorized", message: "Сессия истекла, войдите заново." };
  }

  if (response.status === 429) {
    const body = (await response.json().catch(() => ({}))) as ErrorBody;
    return {
      ok: false,
      kind: "rate_limited",
      message: body.message ?? "Слишком много запросов. Попробуйте чуть позже.",
      retryAfterMs: body.retryAfterMs,
    };
  }

  if (response.status === 404) {
    // Identical wire shape ({ error: "not_found" }) for "document doesn't
    // exist" and "belongs to someone else" -- see [documentId]/route.ts and
    // [documentId]/refresh/route.ts. Surfaced as its own kind (rather than
    // folded into the generic "error" branch below) so callers that operate
    // on a specific document -- delete, refresh -- can treat it as "already
    // gone" (soft message + refresh the list) instead of a hard failure.
    return {
      ok: false,
      kind: "not_found",
      message: "Документ не найден — возможно, он уже был удалён или обновлён в другой вкладке.",
    };
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ErrorBody;
    return { ok: false, kind: "error", message: describeErrorBody(response.status, body) };
  }

  const data = (await response.json().catch(() => ({}))) as T;
  return { ok: true, data };
}

function describeErrorBody(status: number, body: ErrorBody): string {
  if (typeof body.message === "string" && body.message.length > 0) return body.message;
  if (body.error === "invalid_request") {
    if (typeof body.details === "string") return body.details;
    return "Некорректные данные — проверьте введённое значение.";
  }
  return `Не удалось выполнить запрос (${body.error ?? status}).`;
}

export async function postJson<T>(url: string, body: unknown): Promise<SourceRequestResult<T>> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await normalizeResponse<T>(response);
  } catch {
    return { ok: false, kind: "error", message: "Не удалось подключиться к серверу." };
  }
}

export async function postFormData<T>(url: string, formData: FormData): Promise<SourceRequestResult<T>> {
  try {
    const response = await fetch(url, { method: "POST", body: formData });
    return await normalizeResponse<T>(response);
  } catch {
    return { ok: false, kind: "error", message: "Не удалось подключиться к серверу." };
  }
}

export async function postEmpty<T>(url: string): Promise<SourceRequestResult<T>> {
  try {
    const response = await fetch(url, { method: "POST" });
    return await normalizeResponse<T>(response);
  } catch {
    return { ok: false, kind: "error", message: "Не удалось подключиться к серверу." };
  }
}

/**
 * DELETE with no body -- used by DocumentCard's delete button
 * (`app/api/sources/{documentId}` route). `normalizeResponse` already
 * tolerates an empty response body (`response.json().catch(() => ({}))`),
 * so this works whether the route responds 200 with a JSON body or 204
 * with none.
 */
export async function del<T>(url: string): Promise<SourceRequestResult<T>> {
  try {
    const response = await fetch(url, { method: "DELETE" });
    return await normalizeResponse<T>(response);
  } catch {
    return { ok: false, kind: "error", message: "Не удалось подключиться к серверу." };
  }
}

/** Human-readable suffix for a rate_limited failure -- shared formatting so every form shows the same "(~N сек.)" phrasing. */
export function retryAfterSuffix(retryAfterMs?: number): string {
  if (!retryAfterMs) return "";
  return ` (~${Math.ceil(retryAfterMs / 1000)} сек.)`;
}
