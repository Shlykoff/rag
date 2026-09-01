// lib/gateway/answer.ts
//
// THE seam between the core RAG app and the isolated `lib/channels/`
// module (Telegram etc, see that module's own header). `answerExternalMessage()`
// is the ONLY thing lib/channels/ is allowed to import from the core
// stack -- this file itself is ordinary core-app code and imports
// lib/chat/, lib/ai/, lib/rate-limit/, lib/retrieval/ (transitively, via
// lib/chat/) freely; it is the front door for external callers, not part
// of the isolated module. See CLAUDE.md's non-negotiable rules for the
// enforced import-boundary this asymmetry backs.
//
// Deliberately NON-STREAMING (unlike app/api/chat/route.ts's SSE
// response): a chat platform webhook (Telegram etc) is a simple
// request/response HTTP exchange with no standard "stream partial replies
// back to the user as they're generated" mechanism most channel APIs
// support well -- so this drains lib/chat/handle-chat-request.ts's
// streaming generator into ONE buffered final string before returning,
// trading latency-to-first-token (irrelevant here) for a much simpler
// contract at the lib/channels/ boundary (send one message, once).
//
// PROJECT-OWNER RESOLUTION: unlike the web test-chat path
// (app/api/chat/route.ts), there is no signed-in user/session here at
// all -- an inbound webhook has no Supabase session. `projectId` comes
// from the `channel_integrations` row that received the webhook (see
// lib/channels/telegram/adapter.ts), which is itself looked up by
// `service_role` -- this function re-resolves the project's owner
// (`projects.user_id`) directly via `service_role`, the same trust
// boundary the match_document_chunks RPC's own security comment describes
// for this exact path ("gateway/channels path: verified via the
// channel_integrations row that received the inbound webhook -- project_id
// never comes from anything in the inbound platform payload itself").
//
// THREE CONCURRENCY LAYERS (the user's explicit "many concurrent external
// participants can hit one project at once" requirement), composed here in
// this exact order -- verify/resolve owner -> layer 2 -> layer 3 acquire ->
// layer 1 -> provider+pipeline -> layer 3 release in `finally`:
//   1. Per-project aggregate (lib/rate-limit/rate-limiter.ts's
//      reserveChatRateLimitSlot, re-keyed to projectId) -- the real
//      money/quota budget, shared across this project's owner test chat
//      AND every external channel session of this project.
//   2. Per-external-participant (lib/rate-limit/channel-participant-rate-limiter.ts)
//      -- tighter than layer 1, so one abusive participant can't starve
//      the rest of a project's audience out of the shared layer-1 budget.
//      Checked BEFORE layer 3/1 so a spamming participant is rejected as
//      cheaply as possible, before contending for the lock or eating into
//      the shared project budget.
//   3. Per-conversation processing lock (lib/rate-limit/conversation-lock.ts)
//      -- mutual exclusion, not a counting window: rejects (does not
//      queue) an overlapping message from a participant whose previous
//      message is still being answered (e.g. a webhook retry landing
//      mid-flight). Acquired AFTER layer 2 (no point locking a request
//      that's about to be rate-limited anyway) but BEFORE layer 1 (holding
//      the lock is what makes it safe to reserve/release a layer-1 slot
//      without a second concurrent turn for the same participant
//      interleaving in between).
// See each module's own header comment for the full reasoning/limitations
// (especially conversation-lock.ts's documented multi-instance caveat).

import "server-only";
import { getServiceRoleClient } from "../supabase/service-client";
import { getAIProviders, AIProviderError } from "../ai";
import { handleChatRequest } from "../chat/handle-chat-request";
import { reserveChatRateLimitSlot } from "../rate-limit/rate-limiter";
import { checkChannelParticipantRateLimit } from "../rate-limit/channel-participant-rate-limiter";
import { acquireConversationLock, releaseConversationLock } from "../rate-limit/conversation-lock";

export interface GatewayAnswerRequest {
  projectId: string;
  /** Opaque label, e.g. "telegram" -- the gateway doesn't interpret this beyond using it as part of a rate-limit/lock key and forwarding it to handleChatRequest's externalParticipant.channel. */
  channel: string;
  /** e.g. a Telegram chat_id, as text. */
  externalParticipantId: string;
  message: string;
}

export type GatewayAnswerResult =
  | { kind: "ok"; text: string }
  | { kind: "rate_limited" }
  | { kind: "no_credentials" }
  | { kind: "error" };

interface ProjectOwnerRow {
  id: string;
  user_id: string;
}

/**
 * Answers one external channel message end-to-end (retrieval + generation)
 * and returns a single buffered result -- never throws; every failure mode
 * (project missing, rate-limited at any of the three layers, no AI
 * provider configured, or a real provider/DB failure) is mapped to a
 * GatewayAnswerResult so lib/channels/ adapters never need to catch a
 * gateway exception, only branch on `.kind`.
 */
export async function answerExternalMessage(req: GatewayAnswerRequest): Promise<GatewayAnswerResult> {
  const supabase = getServiceRoleClient();

  // Resolve the project + its owner via service_role -- there is no
  // Supabase session on an inbound webhook to derive this from RLS (see
  // module header). A missing project is not one of the four documented
  // result kinds' "expected" cases (channel_integrations.project_id is a
  // real FK to projects, so this should be unreachable in practice unless
  // a project was deleted out from under a still-enabled integration) --
  // treated as a generic, logged `error`.
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id, user_id")
    .eq("id", req.projectId)
    .maybeSingle<ProjectOwnerRow>();
  if (projectError) {
    console.error(`answerExternalMessage: failed to load project ${req.projectId}:`, projectError);
    return { kind: "error" };
  }
  if (!project) {
    console.error(`answerExternalMessage: project ${req.projectId} does not exist (stale channel_integrations row?)`);
    return { kind: "error" };
  }
  const ownerUserId = project.user_id;

  // Layer 2: per-external-participant. Checked first (cheapest, no lock
  // contention, no DB round-trip) -- see module header for ordering
  // rationale.
  const participantLimit = checkChannelParticipantRateLimit(req.projectId, req.channel, req.externalParticipantId);
  if (!participantLimit.allowed) {
    return { kind: "rate_limited" };
  }

  // Layer 3: per-conversation lock. Reject (don't queue) if this
  // participant's previous turn is still in flight -- see
  // lib/rate-limit/conversation-lock.ts's header for the full reasoning
  // and its documented multi-instance limitation.
  const lockAcquired = acquireConversationLock(req.projectId, req.channel, req.externalParticipantId);
  if (!lockAcquired) {
    return { kind: "rate_limited" };
  }

  try {
    // Layer 1: per-project aggregate, shared across this project's owner
    // test chat AND every external session (re-keyed reserveChatRateLimitSlot,
    // see lib/rate-limit/rate-limiter.ts). Reserved (not just checked) for
    // the same parallel-burst-closing reason app/api/chat/route.ts uses it
    // -- released in the inner `finally` below once this turn is fully
    // done, success or failure.
    const projectLimit = await reserveChatRateLimitSlot(supabase, req.projectId);
    if (!projectLimit.allowed) {
      return { kind: "rate_limited" };
    }

    try {
      let chatProvider;
      let embeddingsProvider;
      try {
        // preFetchedProjectRow: this exact `{id, user_id}` row was already
        // fetched via service_role a few lines up (to resolve ownerUserId
        // in the first place) -- passing it through here skips
        // getAIProviders()'s own otherwise-identical re-fetch of the same
        // row, while it still runs the same in-memory ownership guard
        // against it. See GetAIProvidersParams.preFetchedProjectRow's own
        // doc comment for why this is safe here specifically (and why
        // app/api/chat/route.ts's web path must NOT do the same).
        ({ chatProvider, embeddingsProvider } = await getAIProviders(
          { projectId: req.projectId, ownerUserId, preFetchedProjectRow: project },
          supabase
        ));
      } catch (err) {
        if (err instanceof AIProviderError && err.kind === "no_credentials") {
          // Expected per-project state ("this project hasn't picked a
          // model yet"), not a server fault -- deliberately no
          // console.error, same posture as app/api/chat/route.ts's 422
          // branch.
          return { kind: "no_credentials" };
        }
        console.error("answerExternalMessage: getAIProviders() failed:", err);
        return { kind: "error" };
      }

      const events = handleChatRequest(
        {
          projectId: req.projectId,
          ownerUserId,
          message: req.message,
          externalParticipant: { channel: req.channel, participantId: req.externalParticipantId },
        },
        { supabase, chatProvider, embeddingsProvider }
      );

      // Drain the streaming generator into one buffered final string --
      // see module header for why this is deliberately non-streaming. If
      // handleChatRequest yields an `error` event at any point (a known,
      // already-classified failure -- see that module's own "Error
      // handling" doc comment), the whole turn is reported as `error`
      // here, even if some delta text had already accumulated: partial/
      // truncated text is not a useful reply to send back to a channel
      // participant, and handleChatRequest itself never persists a partial
      // assistant message on this path either.
      //
      // Defense-in-depth: this function is documented to never throw (see
      // its own doc comment). handleChatRequest is documented to yield a
      // `type: "error"` event for every known failure mode rather than
      // throw, but a raw exception escaping it anyway must still never
      // propagate out of this function and past lib/channels/'s import
      // boundary as an uncaught exception. The try/catch below holds that
      // guarantee even if handleChatRequest's own contract is ever violated
      // by a future change.
      let text = "";
      try {
        for await (const event of events) {
          if (event.type === "delta") {
            text += event.text;
          } else if (event.type === "error") {
            console.error(`answerExternalMessage: handleChatRequest error event: ${event.message}`);
            return { kind: "error" };
          }
        }
      } catch (err) {
        console.error("answerExternalMessage: handleChatRequest threw unexpectedly while streaming:", err);
        return { kind: "error" };
      }
      return { kind: "ok", text };
    } finally {
      // Release layer 1's reservation regardless of success/failure below
      // it -- mirrors app/api/chat/route.ts's own `releaseRateLimitSlot()`
      // usage. Only reached when `projectLimit.allowed` was true (the
      // `if (!projectLimit.allowed) return` above exits before this
      // `try`), so `.release` is always present here.
      if (projectLimit.allowed) projectLimit.release();
    }
  } finally {
    // Release layer 3's lock regardless of what happened above -- this is
    // the ONLY path that releases it, since every early return above this
    // point happens BEFORE the lock is acquired.
    releaseConversationLock(req.projectId, req.channel, req.externalParticipantId);
  }
}
