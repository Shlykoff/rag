// lib/http/parse-json-body.ts
//
// Shared "parse JSON -> 400 on failure -> zod-validate -> 400 with
// flattened errors" boilerplate, promoted out of what used to be a private
// helper (first written in app/api/profile/ai-providers/route.ts) hand-
// duplicated -- not imported -- across 9+ app/api/** route files, all
// wanting the exact same two-step failure shape
// (`{ error: "invalid_request", details }`, 400 status) whether the body
// isn't valid JSON at all or is valid JSON that fails its own zod schema.
// `lib/http/` (not a route-local helper) since this is genuinely shared
// across unrelated route trees (chat, projects, sources, profile), unlike
// e.g. app/api/projects/shared.ts's DTO helpers, which are specific to one
// feature's own two callers.

import "server-only";
import type { z } from "zod";

export type ParseJsonBodyResult<T> = { data: T } | { errorResponse: Response };

/**
 * Parses `request`'s body as JSON and validates it against `schema`.
 * Callers use this immediately after their own auth/rate-limit checks:
 *
 *   const parsed = await parseJsonBody(request, BodySchema);
 *   if ("errorResponse" in parsed) return parsed.errorResponse;
 *   // parsed.data is now the validated, typed body.
 *
 * Both failure modes (malformed JSON, JSON that fails `schema`) return the
 * identical `{ error: "invalid_request", details }` 400 shape every one of
 * these routes already committed to in its own request contract.
 */
export async function parseJsonBody<T>(
  request: Request,
  schema: z.ZodType<T>
): Promise<ParseJsonBodyResult<T>> {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return {
      errorResponse: Response.json({ error: "invalid_request", details: "Body must be valid JSON." }, { status: 400 }),
    };
  }
  const parsed = schema.safeParse(rawBody);
  if (!parsed.success) {
    return {
      errorResponse: Response.json({ error: "invalid_request", details: parsed.error.flatten() }, { status: 400 }),
    };
  }
  return { data: parsed.data };
}
