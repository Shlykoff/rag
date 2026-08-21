// app/api/channels/telegram/[integrationId]/route.ts
//
// Inbound Telegram webhook endpoint -- one URL per project's Telegram
// integration (scripts/telegram-set-webhook.ts registers this exact path,
// with `integrationId` = the channel_integrations row's own id, with
// Telegram via setWebhook). Deliberately THIN: service-role lookup of the
// integration row by the path id, then delegate everything else to
// lib/channels/telegram/adapter.ts's handleTelegramWebhook() -- all
// verification (webhook secret), parsing, dedup, command handling, and the
// actual RAG turn happen there, not in this file.
//
// CRITICAL CONTRACT: this route ALWAYS returns 200, regardless of what
// happened internally (bad secret, unknown integration, disabled
// integration, a processing error, ...). Telegram retries webhook
// deliveries on any non-2xx response OR a slow one -- returning a
// different status code here (even a "correct" 401/404/500) would trigger
// a retry storm layered on top of an already-slow RAG pipeline, which is
// strictly worse than swallowing the failure here (every internal failure
// mode is already logged server-side by whichever layer detected it -- see
// adapter.ts's own comments). This is why `getIntegration` failing, or the
// integration being missing/disabled, is handled by simply returning early
// with 200, not by mapping to an HTTP error status the way every OTHER
// route in this project does.
//
// No projectId is ever trusted from the inbound Telegram payload itself --
// it's derived exclusively from the looked-up channel_integrations row,
// per lib/gateway/answer.ts's own security comment on this exact point.

import "server-only";
import { getServiceRoleClient } from "@/lib/supabase/service-client";
import { getTelegramIntegrationById } from "@/lib/channels/telegram/integration-store";
import { handleTelegramWebhook } from "@/lib/channels/telegram/adapter";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ integrationId: string }> }
): Promise<Response> {
  const { integrationId } = await params;

  try {
    const supabase = getServiceRoleClient();
    const integration = await getTelegramIntegrationById(supabase, integrationId);

    // Unknown integration id, or the owner has since disabled/deleted it --
    // still 200 (see module header): there is no participant-facing action
    // to take, and returning anything else just invites a Telegram retry
    // loop against an id that will never resolve.
    if (!integration || !integration.enabled) {
      if (!integration) {
        console.error(`telegram webhook: no channel_integrations row found for id ${integrationId}`);
      }
      return new Response(null, { status: 200 });
    }

    await handleTelegramWebhook(request, integration);
  } catch (err) {
    // Defensive backstop (see adapter.ts's own comment: handleTelegramWebhook
    // itself is designed to never throw) -- an unexpected exception
    // anywhere in this path must still resolve to 200, not surface as a
    // failed webhook delivery.
    console.error(`telegram webhook: unhandled error for integration ${integrationId}:`, err);
  }

  return new Response(null, { status: 200 });
}
