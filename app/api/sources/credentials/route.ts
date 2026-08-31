// app/api/sources/credentials/route.ts
//
// Stores a user's per-source credential (Notion Internal Integration
// Secret, or a Google Cloud Service Account JSON) encrypted at rest via
// lib/sources/credentials.ts (AES-256-GCM, see lib/sources/crypto.ts). The
// plaintext credential is never echoed back in any response, logged, or
// exposed to the client after this call -- GET only returns whether a
// credential exists per source, never its value.
//
// Request contract:
//   POST /api/sources/credentials
//   body: { sourceType: "notion" | "google_drive", credential: string }
//     - notion: the Internal Integration Secret string
//     - google_drive: the full service-account JSON key, as one string
//   -> 401 { error: "unauthorized" }
//   -> 400 { error: "invalid_request", details }
//   -> 200 { status: "saved" }
//
//   GET /api/sources/credentials
//   -> 401 { error: "unauthorized" }
//   -> 200 { notion: boolean, google_drive: boolean }

import "server-only";
import { z } from "zod";
import { getServiceRoleClient } from "@/lib/supabase/service-client";
import { getAuthenticatedUser, getRouteHandlerSupabaseClient } from "@/lib/supabase/server-client";
import { saveSourceCredential, hasSourceCredential, type SourceCredentialType } from "@/lib/sources/credentials";
import { isValidGoogleDriveCredentialFormat } from "@/lib/sources/google-drive";
import { parseJsonBody } from "@/lib/http/parse-json-body";

// Per-source format validators, keyed generically so this route never has
// to special-case `sourceType === "google_drive"` (or any future source)
// in its own control flow -- it just looks up whatever hook (if any) that
// source registered. Notion has no entry: an Internal Integration Secret
// is an opaque bearer string with no structural format to check up front.
const CREDENTIAL_FORMAT_CHECKS: Partial<
  Record<SourceCredentialType, { validate: (credential: string) => boolean; invalidMessage: string }>
> = {
  google_drive: {
    validate: isValidGoogleDriveCredentialFormat,
    invalidMessage: "credential must be the service account's full JSON key.",
  },
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BodySchema = z.object({
  sourceType: z.enum(["notion", "google_drive"]),
  credential: z.string().min(1, "credential must not be empty"),
});

export async function POST(request: Request): Promise<Response> {
  const authClient = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(authClient);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const parsed = await parseJsonBody(request, BodySchema);
  if ("errorResponse" in parsed) return parsed.errorResponse;

  const formatCheck = CREDENTIAL_FORMAT_CHECKS[parsed.data.sourceType];
  if (formatCheck && !formatCheck.validate(parsed.data.credential)) {
    return Response.json({ error: "invalid_request", details: formatCheck.invalidMessage }, { status: 400 });
  }

  const supabase = getServiceRoleClient();
  await saveSourceCredential(supabase, user.id, parsed.data.sourceType, parsed.data.credential);
  return Response.json({ status: "saved" }, { status: 200 });
}

export async function GET(): Promise<Response> {
  const authClient = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(authClient);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const supabase = getServiceRoleClient();
  const [notion, googleDrive] = await Promise.all([
    hasSourceCredential(supabase, user.id, "notion"),
    hasSourceCredential(supabase, user.id, "google_drive"),
  ]);
  return Response.json({ notion, google_drive: googleDrive }, { status: 200 });
}
