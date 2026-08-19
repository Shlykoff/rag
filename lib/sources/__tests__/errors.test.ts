// lib/sources/__tests__/errors.test.ts
//
// Regression coverage for safeErrorForLog(): a raw googleapis/gaxios error
// carries the full outgoing HTTP request (including the service account's
// live OAuth `Authorization: Bearer <token>` header, set by
// google-auth-library) as `err.config`/`err.response.config`. When wrapped
// as `SourceError.cause` (see lib/sources/google-drive.ts's
// translateDriveError()), logging the SourceError -- or its `.cause` --
// directly would put that token in the logs the instant anything inspects
// deeper than Node's default `util.inspect` depth (a structured/JSON
// logger, `console.dir(err, { depth: null })`, etc). safeErrorForLog() is
// the one function allowed to pull loggable fields off an arbitrary caught
// error; every call site is expected to route through it instead of
// logging the raw object.

import { describe, expect, it } from "vitest";
import { SourceError, safeErrorForLog } from "../errors";

/** Minimal stand-in for a real GaxiosError -- shaped closely enough (status/code + a `config.headers.Authorization`) to prove the redaction, without pulling in the real googleapis/gaxios dependency for a unit test. */
function fakeGaxiosError(token: string): Error & Record<string, unknown> {
  const err = new Error("Request failed with status code 403") as Error & Record<string, unknown>;
  err.name = "GaxiosError";
  err.code = "403";
  err.config = {
    url: "https://www.googleapis.com/drive/v3/files/abc123",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "google-api-nodejs-client/9.0.0",
    },
  };
  err.response = {
    status: 403,
    config: err.config,
    data: { error: { message: "The caller does not have permission" } },
  };
  return err;
}

describe("safeErrorForLog", () => {
  it("never includes the token when logging a SourceError wrapping a raw gaxios error as .cause", () => {
    const secretToken = "ya29.super-secret-live-access-token-do-not-leak";
    const rawGaxiosError = fakeGaxiosError(secretToken);
    const sourceError = new SourceError({
      source: "google_drive",
      kind: "not_shared",
      message: "google drive 403 (files.get(abc123))",
      userMessage: "Нет доступа -- убедитесь, что папка расшарена на email сервисного аккаунта.",
      cause: rawGaxiosError,
      status: 403,
    });

    const logged = safeErrorForLog(sourceError);
    const serialized = JSON.stringify(logged);

    expect(serialized).not.toContain(secretToken);
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("Bearer");
    // No `.cause`/`.config`/`.headers` key at all -- not just "the token
    // happens not to appear this time".
    expect(logged).not.toHaveProperty("cause");
    expect(logged).not.toHaveProperty("config");
    expect(logged).not.toHaveProperty("headers");
    // Still useful for debugging: kind/source/status/message survive.
    expect(logged).toMatchObject({ name: "SourceError", source: "google_drive", kind: "not_shared", status: 403 });
  });

  it("never includes the token when logging the raw (unwrapped) vendor error directly", () => {
    const secretToken = "ya29.another-secret-token";
    const rawGaxiosError = fakeGaxiosError(secretToken);

    const logged = safeErrorForLog(rawGaxiosError);
    const serialized = JSON.stringify(logged);

    expect(serialized).not.toContain(secretToken);
    expect(serialized).not.toContain("Authorization");
    expect(logged).not.toHaveProperty("config");
    expect(logged).not.toHaveProperty("response");
    // The one-level-deep status/code duck-type is still preserved for
    // debugging, since it's not sensitive on its own (surfaced under
    // `status` regardless of whether the source field was `.status` or
    // `.code` -- see extractStatusForLog()).
    expect(logged).toMatchObject({ name: "GaxiosError", status: "403" });
  });

  it("handles a plain string thrown as an error without crashing or losing information", () => {
    expect(safeErrorForLog("boom")).toEqual({ message: "boom" });
  });

  it("handles a non-Error, non-string thrown value without crashing", () => {
    expect(safeErrorForLog({ weird: "shape" })).toEqual({ message: "non-Error value thrown" });
  });
});
