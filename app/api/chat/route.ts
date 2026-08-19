// app/api/chat/route.ts
//
// Streaming chat endpoint. Thin HTTP adapter around
// lib/chat/handle-chat-request.ts: auth -> rate limit (proper 401/429
// status codes, checked BEFORE any AI-provider call per CLAUDE.md rule 4)
// -> hand off to the framework-agnostic pipeline -> frame its events as
// Server-Sent Events.
//
// Request contract (consumed by nextjs-frontend):
//   POST /api/chat
//   body: { conversationId?: string; message: string }
//   -> 401 { error: "unauthorized" } if there is no valid session
//   -> 400 { error: "invalid_request", details } on a malformed body
//   -> 429 { error: "rate_limited", message, retryAfterMs } if the user is
//      over the chat rate limit (Retry-After header set, in seconds)
//   -> 500 { error: "provider_unavailable", message } if the configured
//      AI_PROVIDER (or its matching *_API_KEY) is missing/invalid -- this
//      is a server misconfiguration, not a per-request failure, so it's
//      surfaced as a real HTTP error status with a JSON body rather than
//      the 200 SSE `error` event used for in-stream failures below.
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
import { getAIProviders, type ChatProvider, type EmbeddingsProvider } from "@/lib/ai";
import { getServiceRoleClient } from "@/lib/supabase/service-client";
import { getAuthenticatedUser, getRouteHandlerSupabaseClient } from "@/lib/supabase/server-client";
import { reserveChatRateLimitSlot } from "@/lib/rate-limit/rate-limiter";
import { handleChatRequest, type ChatStreamEvent } from "@/lib/chat/handle-chat-request";

// Streaming responses must not be pre-rendered/cached and need the Node.js
// runtime (the AI SDK provider packages and the Supabase client both
// assume Node APIs) rather than the Edge runtime.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ChatRequestBodySchema = z.object({
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
  // full explanation and its documented multi-instance limitation.
  const rateLimit = await reserveChatRateLimitSlot(supabase, user.id);
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

  // getAIProviders() throws SYNCHRONOUSLY when AI_PROVIDER (or its matching
  // *_API_KEY) is missing/invalid (see lib/ai/index.ts). Before this fix
  // that throw happened outside any try/catch in this route, producing a
  // bare 500 with no body/Content-Type -- reproduced live by qa-reviewer
  // via curl. That violates this file's own documented contract (only
  // 401/400/429/200-SSE were specified), so catch it explicitly and return
  // a real JSON error body, consistent with the 401/400/429 branches above.
  // The reserved rate-limit slot must still be released here: we're
  // returning before the ReadableStream (whose `finally` normally does
  // this) is ever constructed.
  let chatProvider: ChatProvider;
  let embeddingsProvider: EmbeddingsProvider;
  try {
    ({ chatProvider, embeddingsProvider } = getAIProviders());
  } catch (err) {
    releaseRateLimitSlot();
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
    { userId: user.id, conversationId: parsed.data.conversationId, message: parsed.data.message },
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
