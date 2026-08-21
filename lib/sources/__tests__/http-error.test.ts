// lib/sources/__tests__/http-error.test.ts
//
// Regression coverage for the live bug this fixes: a user with a stored but
// non-active AI provider credential (e.g. saved a Gemini key in /profile but
// never picked it as their active provider) hit POST /api/sources/upload and
// got a generic, unhelpful `500 { error: "internal_error" }` instead of the
// same clean `422 { error: "no_credentials" }` that /api/chat already
// returns for the exact same underlying state. Every app/api/sources/*
// route (upload/notion/url/google-drive/refresh) funnels its catch block
// through sourceErrorResponse() -- see that function's own comment for why
// the fix lives here, once, rather than duplicated per route.

import { describe, expect, it, vi } from "vitest";
import { sourceErrorResponse } from "../http-error";
import { SourceError } from "../errors";
import { AIProviderError } from "../../ai/errors";

describe("sourceErrorResponse", () => {
  it("returns 422 { error: 'no_credentials' } for AIProviderError{kind:'no_credentials'} without logging it as a server error", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const err = new AIProviderError({
      provider: "none",
      kind: "no_credentials",
      retryable: false,
      message: "getAIProviders: user abc123 has no active_ai_provider set.",
      userMessage: "Добавьте и выберите AI-провайдера в профиле, чтобы начать общаться с ассистентом.",
    });

    const response = sourceErrorResponse(err);
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toEqual({
      error: "no_credentials",
      message: "Добавьте и выберите AI-провайдера в профиле, чтобы начать общаться с ассистентом.",
    });
    // This is an expected, common per-user state, not a server fault --
    // must NOT be logged the same way a real 500 would be (see this
    // function's own doc comment, mirroring app/api/chat/route.ts's
    // identical rationale).
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it("still returns a logged 500 for a non-'no_credentials' AIProviderError (e.g. a real embeddings-provider outage)", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const err = new AIProviderError({
      provider: "openai",
      kind: "server_error",
      retryable: true,
      status: 503,
      message: "openai API server error (503): upstream outage",
      userMessage: "Сервис временно недоступен, попробуйте ещё раз через некоторое время.",
    });

    const response = sourceErrorResponse(err);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("internal_error");
    // A genuine server-side fault -- still logged, unlike no_credentials
    // above.
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it("still maps a SourceError to its documented status/kind (unaffected by the AIProviderError branch)", async () => {
    const err = new SourceError({
      source: "notion",
      kind: "not_shared",
      message: "notion 403",
      userMessage: "Страница не расшарена на интеграцию.",
    });

    const response = sourceErrorResponse(err);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toEqual({ error: "not_shared", message: "Страница не расшарена на интеграцию." });
  });

  it("still returns a logged 500 for a totally unclassified thrown value (e.g. a DB write bug)", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = sourceErrorResponse(new Error("db write failed"));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("internal_error");
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
