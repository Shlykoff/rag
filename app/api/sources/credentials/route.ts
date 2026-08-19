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
import { saveSourceCredential, hasSourceCredential } from "@/lib/sources/credentials";

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

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ error: "invalid_request", details: "Body must be valid JSON." }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json({ error: "invalid_request", details: parsed.error.flatten() }, { status: 400 });
  }

  if (parsed.data.sourceType === "google_drive") {
    try {
      JSON.parse(parsed.data.credential);
    } catch {
      return Response.json(
        { error: "invalid_request", details: "credential must be the service account's full JSON key." },
        { status: 400 }
      );
    }
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
