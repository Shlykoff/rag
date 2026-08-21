// app/api/chat/route.ts
//
// Streaming chat endpoint. Thin HTTP adapter around
// lib/chat/handle-chat-request.ts: auth -> project-ownership verification
// -> rate limit (proper 401/404/429 status codes, checked BEFORE any
// AI-provider call per CLAUDE.md rule 4) -> hand off to the
// framework-agnostic pipeline -> frame its events as Server-Sent Events.
//
// PROJECTS PIVOT: this is the project owner's own in-app test-chat path --
// it always resolves an `externalParticipant`-less ChatRequestInput (see
// lib/chat/handle-chat-request.ts). The gateway (lib/gateway/answer.ts) is
// the parallel, non-streaming entry point for external channel messages
// (Telegram etc); it does its own project-owner resolution + all three
// concurrency layers rather than reusing this route.
//
// Request contract (consumed by nextjs-frontend):
//   POST /api/chat
//   body: { projectId: string; conversationId?: string; message: string }
//   -> 401 { error: "unauthorized" } if there is no valid session
//   -> 400 { error: "invalid_request", details } on a malformed body
//   -> 404 { error: "not_found" } if `projectId` doesn't exist or doesn't
//      belong to the signed-in user -- deliberately identical to "doesn't
//      exist" (not 403) so an authenticated-but-unauthorized caller can't
//      use this endpoint to probe which project ids exist, same posture as
//      app/api/sources/[documentId]/route.ts's ownership check.
//   -> 429 { error: "rate_limited", message, retryAfterMs } if the project
//      is over its chat rate limit (Retry-After header set, in seconds) --
//      shared across the owner's own test chat and every external channel
//      session of this project (see lib/rate-limit/rate-limiter.ts's
//      "layer 1" comment).
//   -> 422 { error: "no_credentials", message } if this project has no
//      active AI provider configured yet, or its owner's stored
//      credential(s) are missing (see lib/ai/index.ts's getAIProviders()).
//      This is an expected, common per-project state -- NOT a server
//      misconfiguration -- so it's deliberately NOT logged via
//      console.error (every not-yet-configured project's first message
//      would otherwise spam server logs with "errors" that are really just
//      "this project hasn't picked a model yet", drowning out real 500s).
//      This is the wire contract nextjs-frontend's "add an API key" modal
//      is built against: show the modal on 422, keep the generic
//      retry-banner treatment for everything else (400/404/429/500).
//   -> 500 { error: "provider_unavailable", message } for any OTHER failure
//      while building the project's AI provider pair (e.g. a DB error
//      reading ai_provider_credentials/projects) -- a real server-side
//      fault, logged via console.error, surfaced as a real HTTP error
//      status with a JSON body rather than the 200 SSE `error` event used
//      for in-stream failures below.
//   -> 200, Content-Type: text/event-stream, on success. The body is a
//      sequence of SSE events, each `event: <type>\ndata: <json>\n\n`:
//        - conversation: { conversationId } -- always first; the id to use
//          for follow-up requests in the same thread (new or reused).
//        - sources: { sources: ContextSource[] } -- the chunks that
//          actually went into the model's context, before generation
//          starts (see lib/retrieval/search.ts's ContextSource shape).
//        - delta: { text } -- one incremental piece of the answer, in
//          order; concatenate to reconstruct the full text.
//        - done: { usage } -- terminal "success" event with token usage.
//        - error: { message, retryable } -- terminal "failure" event; if
//          this is seen there will be no further events and no `done`.

import "server-only";
import { z } from "zod";
import { getAIProviders, AIProviderError, type ChatProvider, type EmbeddingsProvider } from "@/lib/ai";
import { getServiceRoleClient } from "@/lib/supabase/service-client";
import { getAuthenticatedUser, getRouteHandlerSupabaseClient, verifyProjectOwnership } from "@/lib/supabase/server-client";
import { reserveChatRateLimitSlot } from "@/lib/rate-limit/rate-limiter";
import { handleChatRequest, type ChatStreamEvent } from "@/lib/chat/handle-chat-request";

// Streaming responses must not be pre-rendered/cached and need the Node.js
// runtime (the AI SDK provider packages and the Supabase client both
// assume Node APIs) rather than the Edge runtime.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ChatRequestBodySchema = z.object({
  projectId: z.string().uuid(),
  conversationId: z.string().uuid().optional(),
  // Cap independent of (and tighter than) the context token budget in
  // lib/retrieval/search.ts -- this bounds the cost of a single turn's own
  // question, regardless of how much retrieved context gets attached to it.
  message: z.string().min(1, "message must not be empty").max(4000, "message is too long"),
});

function formatSSE(event: ChatStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export async function POST(request: Request): Promise<Response> {
  const authClient = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(authClient);
  if (!user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ error: "invalid_request", details: "Body must be valid JSON." }, { status: 400 });
  }

  const parsed = ChatRequestBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_request", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { projectId } = parsed.data;

  // Ownership verification BEFORE anything else touches this projectId
  // (rate limiting, provider lookup, retrieval) -- uses the RLS-scoped
  // session client (projects_select_own: auth.uid() = user_id), never the
  // service-role client, so a project this caller doesn't own is
  // indistinguishable from one that doesn't exist at all. See this route's
  // own header comment for the 404-not-403 posture.
  const owned = await verifyProjectOwnership(authClient, projectId);
  if (!owned) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const supabase = getServiceRoleClient();

  // Rate limit check happens here (HTTP layer), BEFORE any AI-provider
  // call (embeddings for retrieval or the chat completion itself) --
  // CLAUDE.md rule 4. Checked outside handleChatRequest so a rejection
  // gets a real 429 status + Retry-After header instead of a 200 SSE
  // stream carrying an error event.
  //
  // reserveChatRateLimitSlot (not the plain DB-only checkChatRateLimit)
  // because the DB-only check alone is bypassable by a parallel burst: the
  // chat_request usage_events row for THIS request isn't written until
  // after its full streamed response finishes (seconds later, at the end
  // of handleChatRequest), so N requests fired in parallel would all query
  // the same too-low COUNT(*) and all pass. reserveChatRateLimitSlot closes
  // that gap with an in-process reservation held for the lifetime of this
  // request -- see lib/rate-limit/rate-limiter.ts's module comment for the
  // full explanation and its documented multi-instance limitation. Keyed
  // by projectId now (not userId) -- this is the shared "layer 1" budget
  // across the owner's own test chat AND every external channel session of
  // this project (see lib/gateway/answer.ts).
  const rateLimit = await reserveChatRateLimitSlot(supabase, projectId);
  if (!rateLimit.allowed) {
    return Response.json(
      {
        error: "rate_limited",
        message: "Сервис перегружен, попробуйте через несколько секунд.",
        retryAfterMs: rateLimit.retryAfterMs,
      },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(rateLimit.retryAfterMs / 1000)) },
      }
    );
  }
  // Released once this request's stream has fully finished (success or
  // failure) in the ReadableStream's `finally` below -- see
  // ReservedChatRateLimitSlot.release's own doc comment for why this is
  // safe to call unconditionally there.
  const releaseRateLimitSlot = rateLimit.release;

  // getAIProviders() (bring-your-own-key, project-scoped -- see
  // lib/ai/index.ts) rejects when this project has no active provider
  // configured, or when its owner's stored credential(s) are missing.
  // Before the original (env-var-driven) version of this fix, an
  // equivalent throw happened outside any try/catch in this route,
  // producing a bare 500 with no body/Content-Type -- reproduced live by
  // qa-reviewer via curl. That violated this file's own documented
  // contract (only 401/400/404/429/200-SSE were specified), so it's caught
  // explicitly here and turned into a real JSON error body, consistent
  // with the other branches above -- now split into two outcomes (see the
  // module header's 422 vs. 500 contract). The reserved rate-limit slot
  // must still be released on both paths: this returns before the
  // ReadableStream (whose `finally` normally does that) is ever
  // constructed.
  let chatProvider: ChatProvider;
  let embeddingsProvider: EmbeddingsProvider;
  try {
    ({ chatProvider, embeddingsProvider } = await getAIProviders({ projectId, ownerUserId: user.id }, supabase));
  } catch (err) {
    releaseRateLimitSlot();
    if (err instanceof AIProviderError && err.kind === "no_credentials") {
      // Expected per-project state, not a server fault -- deliberately no
      // console.error here (see the module header comment above for why
      // logging this as an error would be noise, not signal).
      return Response.json({ error: "no_credentials", message: err.userMessage }, { status: 422 });
    }
    console.error("app/api/chat/route.ts: getAIProviders() failed:", err);
    return Response.json(
      {
        error: "provider_unavailable",
        message: "Сервис временно недоступен. Попробуйте позже.",
      },
      { status: 500 }
    );
  }

  const events = handleChatRequest(
    { projectId, ownerUserId: user.id, conversationId: parsed.data.conversationId, message: parsed.data.message },
    { supabase, chatProvider, embeddingsProvider }
  );

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of events) {
          controller.enqueue(encoder.encode(formatSSE(event)));
        }
      } catch (err) {
        // Unexpected failure (e.g. a DB write erroring) that
        // handleChatRequest didn't already turn into an `error` event --
        // see that module's comment on which failures throw vs yield.
        console.error("app/api/chat/route.ts: unhandled error while streaming chat response:", err);
        controller.enqueue(
          encoder.encode(
            formatSSE({
              type: "error",
              message: "Произошла непредвиденная ошибка. Попробуйте позже.",
              retryable: false,
            })
          )
        );
      } finally {
        releaseRateLimitSlot();
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disables response buffering on Nginx-style reverse proxies so
      // chunks are flushed to the client as they're written, not batched.
      "X-Accel-Buffering": "no",
    },
  });
}
