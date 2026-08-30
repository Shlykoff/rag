// lib/validation/uuid.ts
//
// Shared "is this string shaped like a Postgres uuid" check for every
// route that reads a project/conversation id out of a request body and
// validates it with zod before using it in a Supabase query.
//
// NOT `z.string().uuid()`: Zod v4's built-in `.uuid()` validator is
// RFC-4122-STRICT -- it requires a valid version nibble (1-8) and a valid
// variant nibble, special-casing only the literal all-zero
// (`00000000-0000-0000-0000-000000000000`) and all-`f` UUIDs. Postgres's
// own `uuid` column type enforces NONE of that -- it accepts any
// 36-character, correctly-hyphenated string of hex digits, version/variant
// nibbles or not. Sentinel-style ids (`00000000-0000-0000-0000-00000000000N`)
// are a common, useful convention for readable seed/demo data -- this
// project's own `supabase/seed.sql` uses them for the demo user, project,
// and both demo documents.
//
// Real bug this fixes, reproduced live: `z.string().uuid()` on a
// `projectId` body field rejected the seeded demo project's id
// (`00000000-0000-0000-0000-000000000002`, a valid Postgres `uuid` value
// that is simply not a valid RFC-4122 v1-8 UUID) with a bare
// `400 { error: "invalid_request", details: { fieldErrors: { projectId:
// ["Invalid UUID"] } } }` -- on a real, signed-in demo-account session,
// this blocked `POST /api/chat` and three of the four `/api/sources/*`
// routes entirely (manual upload was unaffected -- it reads `projectId`
// from FormData with only a non-empty-string check, never this schema).
//
// This regex checks SHAPE only (36 chars, hyphens in the standard 8-4-4-4-12
// positions, hex digits) -- not version/variant -- matching exactly what
// Postgres itself accepts for a `uuid` column. This does NOT weaken any
// actual authorization boundary: every route using this still
// independently verifies ownership of whatever the id points at via a real
// database query (an RLS-scoped `projects` lookup, `.eq("project_id", ...)`
// filters, ...) before trusting it for anything -- this schema only
// changes whether a syntactically-plausible-but-non-RFC-strict id can even
// reach that check.

import { z } from "zod";

const UUID_SHAPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidShape(value: string): boolean {
  return UUID_SHAPE_RE.test(value);
}

/** Drop-in replacement for `z.string().uuid()` -- see this file's header for why the built-in validator is too strict for this project's actual data (Postgres `uuid` columns, including sentinel-style seed ids). */
export const uuidShapeSchema = z.string().refine(isUuidShape, { message: "Invalid UUID" });
