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
//
// Also reused by components/profile/* (ProfileForm.tsx, ProviderKeyField.tsx)
// for app/api/profile/ai-providers/route.ts and by components/projects/*
// for app/api/projects/** (ModelPicker.tsx's GET/PUT,
// TelegramChannelPanel.tsx's GET/POST/DELETE) -- all of them follow the
// same 401/429/{error,message} shapes, just over different resources.
// `deleteJson`/`putJson` exist because the profile route needed a DELETE
// with a JSON body (`{ provider }`, unlike `del()`'s no-body DELETE) and a
// PUT at all; `patchJson` exists for the project rename endpoint's PATCH.
// All of them still funnel through the same `normalizeResponse()` so the
// unhappy-path handling doesn't fork per HTTP method.

export interface SourceRequestSuccess<T> {
  ok: true;
  data: T;
}

export interface SourceRequestFailure {
  ok: false;
  kind: "unauthorized" | "rate_limited" | "not_found" | "no_credentials" | "error";
  message: string;
  retryAfterMs?: number;
  /** Raw `error` code from the response body, when present (e.g. "missing_credentials") -- only populated on kind === "error". Most callers only need `message`; this exists for the rare case where a caller needs to react to a *specific* error code rather than just display the message (see components/profile/ActiveProviderSection.tsx's handling of PUT's `missing_credentials` race). */
  code?: string;
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
    // Identical wire shape ({ error: "not_found" }) for "resource doesn't
    // exist" and "belongs to someone else" across every route this module
    // is used against (documents, projects, per-project model settings,
    // per-project channel integrations). Surfaced as its own kind (rather
    // than folded into the generic "error" branch below) so callers that
    // operate on one specific resource -- delete, refresh, rename -- can
    // treat it as "already gone" (soft message + refresh the list) instead
    // of a hard failure. Wording is deliberately resource-agnostic since
    // this branch serves callers for several different resource types.
    return {
      ok: false,
      kind: "not_found",
      message: "Запись не найдена — возможно, её удалили или изменили в другой вкладке.",
    };
  }

  if (response.status === 422) {
    // { error: "no_credentials", message } -- every app/api/sources/* route
    // that ends up calling lib/ai/index.ts's provider lookups returns this
    // exact shape when the signed-in user has no active AI provider
    // configured, or their active provider's credential(s) are missing.
    // Same contract as app/api/chat/route.ts's 422, surfaced as its own
    // kind so source forms can show the same "add a provider" treatment
    // ChatView.tsx already has, instead of a generic error banner. Any
    // other 422 body falls through to the generic "error" branch below.
    const body = (await response.json().catch(() => ({}))) as ErrorBody;
    if (body.error === "no_credentials") {
      return {
        ok: false,
        kind: "no_credentials",
        message: body.message ?? "Добавьте и выберите AI-провайдера в профиле, чтобы добавить источник.",
      };
    }
    return { ok: false, kind: "error", message: describeErrorBody(422, body), code: body.error };
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ErrorBody;
    return { ok: false, kind: "error", message: describeErrorBody(response.status, body), code: body.error };
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

/** Plain GET, same normalize-the-response treatment as every other helper here -- used by the status-fetch-on-mount calls in ModelPicker.tsx, TelegramChannelPanel.tsx, and ProfileForm.tsx. */
export async function getJson<T>(url: string): Promise<SourceRequestResult<T>> {
  try {
    const response = await fetch(url);
    return await normalizeResponse<T>(response);
  } catch {
    return { ok: false, kind: "error", message: "Не удалось подключиться к серверу." };
  }
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

export async function putJson<T>(url: string, body: unknown): Promise<SourceRequestResult<T>> {
  try {
    const response = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await normalizeResponse<T>(response);
  } catch {
    return { ok: false, kind: "error", message: "Не удалось подключиться к серверу." };
  }
}

/** PATCH with a JSON body -- see app/api/projects/[projectId]/route.ts's PATCH contract (`{ name }`, rename). */
export async function patchJson<T>(url: string, body: unknown): Promise<SourceRequestResult<T>> {
  try {
    const response = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await normalizeResponse<T>(response);
  } catch {
    return { ok: false, kind: "error", message: "Не удалось подключиться к серверу." };
  }
}

/** DELETE with a JSON body -- see app/api/profile/ai-providers/route.ts's DELETE contract (`{ provider }`), unlike del()'s no-body DELETE below. */
export async function deleteJson<T>(url: string, body: unknown): Promise<SourceRequestResult<T>> {
  try {
    const response = await fetch(url, {
      method: "DELETE",
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
