# RAG Assistant

An AI assistant with retrieval-augmented generation (RAG) over your own documents — uploaded files, Notion pages, public URLs, and a Google Drive folder — with a provider-independent AI layer (OpenAI / Anthropic+Voyage / Gemini, switchable via one env var) and sources cited under every answer.

Full spec: [`docs/spec.md`](docs/spec.md). Architectural ground rules for every part of this project: [`CLAUDE.md`](CLAUDE.md).

## Status

This project is built incrementally by specialized agents (see `.claude/agents/`). Current state:

- [x] **Database schema** (`db-architect`): Postgres schema, `pgvector`, RLS policies, `match_document_chunks` RPC, migrations, seed data.
- [x] **RAG pipeline** (`rag-pipeline-specialist`, this README section): AI provider abstraction, chunking, embeddings, retrieval, streaming chat API, rate limiting. **This is what's documented below.**
- [ ] **Document sources** (`document-sources-specialist`): manual upload, Notion, public URL (with SSRF protection), Google Drive folder sync. Not built yet — the ingestion pipeline below accepts an already-normalized `{ documentId, userId, title, text }` and has no knowledge of *where* that text came from.
- [ ] **Frontend** (`nextjs-frontend`): chat UI, source-adding screens, history. Not built yet — `app/api/chat/route.ts` is a server-only API route with a documented contract (see below) for the frontend to consume.

There is no live deploy or screenshots yet — those land once the frontend exists.

## Stack

Next.js (App Router, TypeScript strict) · pluggable AI-provider layer (OpenAI / Anthropic+Voyage / Gemini) · Supabase Postgres + `pgvector` + Storage · Vercel AI SDK (`ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`) for streaming · Vitest for tests.

## Running locally

Requires Docker (for local Supabase) and Node **22+** (see `.nvmrc` — `nvm use`). This project's AI/Supabase dependencies (`ai`, `@ai-sdk/*`, `openai`, `@supabase/supabase-js`) require Node 22; if you're on an older Node LTS, `nvm install 22 && nvm use` first.

```bash
git clone <repo>
cd RAG
nvm use                 # Node 22
npm install

supabase start           # local Supabase in Docker; prints local URL/keys
cp .env.example .env.local
# fill in NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY /
# SUPABASE_SERVICE_ROLE_KEY from the `supabase start` output.
# AI_PROVIDER + its API key are optional until you actually want to call a
# real model -- see "What hasn't been tested live" below.

npm run dev               # http://localhost:3000 (once nextjs-frontend adds pages)
```

### Tests

```bash
npm test                  # fast unit tests, no Docker required (77 tests)
npm run test:integration  # requires `supabase start` first -- runs against
                           # the real local Postgres/pgvector (11 tests)
```

`npm test` never touches a database — everything is exercised against fakes (see e.g. `lib/ingestion/__tests__/ingest.test.ts`). `npm run test:integration` loads `.env.local` (via Node's `--env-file`) and runs a second suite of `*.integration.test.ts` files against your local `supabase start` instance: real inserts, a real `match_document_chunks` RPC call, real cross-tenant isolation checks. It's a separate Vitest config (`vitest.integration.config.mts`) specifically so plain `npm test`/CI never needs Docker running.

## Architecture: the AI provider abstraction (`lib/ai/`)

Business logic (retrieval, the chat API route, ingestion) never imports `openai`, `@ai-sdk/*`, or `voyageai` directly — only `lib/ai/index.ts`'s `getAIProviders()` factory, which returns a `{ chatProvider, embeddingsProvider }` pair selected by `AI_PROVIDER`:

| `AI_PROVIDER` | Chat | Embeddings | Notes |
|---|---|---|---|
| `openai` | `gpt-4.1-mini` via `@ai-sdk/openai` streaming | `text-embedding-3-small`, `dimensions: 1024` | default; cheapest to keep alive for a demo |
| `anthropic` | `claude-sonnet-4-5` via `@ai-sdk/anthropic` streaming | Voyage `voyage-3-large`, `outputDimension: 1024` | Anthropic has no embeddings API — Voyage is a fixed pairing, not independently configurable |
| `gemini` | `gemini-2.5-flash` | `gemini-embedding-001`, `dimensions: 1024` | reuses the **same** `OpenAICompatibleProvider` class as `openai`, just pointed at Google's official OpenAI-compatible endpoint (`https://generativelanguage.googleapis.com/v1beta/openai/`) via a different `baseURL`/`apiKey`/`model` — see `lib/ai/providers/gemini.ts`. This is a deliberate reuse (Google guarantees wire-format compatibility for this subset of the API), not a copy-paste shortcut. |

All three are pinned to **1024-dimensional** vectors (`dimensions`/`outputDimension`), matching `document_chunks.embedding vector(1024)` — switching providers never requires a schema migration. 1024 (not the more common 1536) was chosen specifically because **Voyage AI does not support 1536 at all**: `voyage-3-large`/`voyage-4` only accept `output_dimension` from the fixed set `{256, 512, 1024, 2048}`, and since Anthropic has no embeddings API of its own, `AI_PROVIDER=anthropic` depends on Voyage. 1024 is Voyage's own default and the common denominator — OpenAI and Gemini can both shorten their native embedding output down to an arbitrary dimension (including 1024), so pinning everyone to 1024 is what makes all three providers usable behind one `vector(1024)` column. **Switching providers does always require a full re-ingest**: different embedding models produce incompatible vector spaces even at equal dimensionality. `document_chunks.embedding_provider`/`embedding_model` record which provider/model produced each row specifically so a provider switch's "which documents need re-embedding" question has a real SQL answer (`select distinct embedding_provider, embedding_model from document_chunks`), not "ask whoever remembers".

Two interfaces, in `lib/ai/types.ts`:

```ts
interface ChatProvider {
  providerName: string;
  modelName: string;
  streamChat(input: { systemPrompt: string; messages: ChatMessage[] }): ChatStreamResult;
  // ChatStreamResult = { textStream: AsyncIterable<string>; usage: Promise<TokenUsage>; text: Promise<string> }
}

interface EmbeddingsProvider {
  providerName: string;
  modelName: string;
  dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}
```

Adapters (`lib/ai/providers/{openai,anthropic,voyage,gemini}.ts`) wrap the official Vercel AI SDK provider packages for chat streaming (`streamText` from `ai`, with `@ai-sdk/openai`/`@ai-sdk/anthropic` as the model), not a hand-rolled SSE parser. Embeddings go through the raw `openai`/`voyageai` SDKs directly (simpler control over the `dimensions`/`outputDimension` param and batch response shape than routing through the `ai` package's embedding helpers).

### Error handling (`lib/ai/errors.ts`, `lib/ai/retry.ts`, `lib/ai/stream-utils.ts`)

Every vendor SDK throws a different error shape for "you're rate limited" or "we're down". `normalizeProviderError()` duck-types the common fields (`status`/`statusCode`/`response.status`, plus the AI SDK's own `isRetryable` hint) into one `AIProviderError { kind, retryable, userMessage, status }`, so nothing outside `lib/ai/` ever branches on a vendor-specific error class.

- **Embeddings** (non-streaming): `withRetry()` — exponential backoff + jitter, retries `429`/`5xx`/network errors, gives up after 2 retries (3 attempts total) and throws the normalized error. Each provider's own SDK-level retry is disabled (`maxRetries: 0` on the client) so there's exactly one retry policy, not two racing each other.
- **Chat streaming**: `wrapAiSdkStream()` implements **retry-before-first-token**: if the request fails before any text has reached the caller, the whole thing is retried from scratch with backoff. The instant one chunk has been yielded, retries stop completely — restarting mid-stream would duplicate or garble text a UI may have already rendered. (This exact bug — retrying after a chunk had already been yielded — was caught by `lib/ai/__tests__/stream-utils.test.ts` during development; see that file's "does NOT retry once a chunk has already been yielded" test.)
- **Embedding batches**: `lib/ai/embed-batch.ts` batches (not one API call per chunk) and, if a whole batch fails (one malformed/oversized input fails the *entire* HTTP call, as these APIs work), **bisects** the batch to isolate exactly which input(s) are the problem — every other input in that batch still gets embedded normally instead of the whole batch failing for one bad chunk.
- **Unhandled rejection safety**: `wrapAiSdkStream()`'s `usage`/`text` promises reject whenever the underlying stream fails. The common failure path (`lib/chat/handle-chat-request.ts` catches a mid-stream error, yields an `error` SSE event, and returns) legitimately never touches `.usage`/`.text` on that path — and Node's default `--unhandled-rejections=throw` (Node 15+) crashes the *entire process*, taking down every in-flight request for every user, for any promise nobody ever attached a handler to. `wrapAiSdkStream()` attaches an internal no-op `.catch(() => {})` directly on the `usage`/`text` promises it returns — this only marks them "handled" for Node's tracking (attaching `.catch()` to a promise never replaces or consumes it; every independent `await`/`.then()` a caller attaches afterwards still observes the real rejection normally) — so a caller that never reads `.usage`/`.text` on an error path can no longer crash the process. Regression-tested in `lib/ai/__tests__/stream-utils.test.ts` ("never produces an unhandled promise rejection...") by reproducing `handle-chat-request.ts`'s exact pattern (drain `textStream`, catch, never touch `usage`/`text`) with no manual `.catch()` in the test itself; confirmed this test actually fails (non-zero exit) against the pre-fix code, not just green regardless.
- **Retrieval errors get the same treatment as chat-completion errors**: `handleChatRequest` wraps `runRetrieval(...)` (which calls `embeddingsProvider.embed()` for the question) in the same normalize-and-yield pattern already used for `chatProvider.streamChat(...)`. Previously only chat-completion failures became a graceful `{ type: "error", retryable, message }` SSE event with the real provider-reported `retryable`/`userMessage` — an embeddings failure (e.g. a 429 from Voyage) instead escaped `handleChatRequest` entirely and was caught only by `app/api/chat/route.ts`'s generic catch-all, which always hardcodes `retryable: false` regardless of what actually happened. Since `EmbeddingsProvider.embed()` always rejects with an already-normalized `AIProviderError` (never a raw vendor error — see `lib/ai/types.ts`'s contract), `handleChatRequest` can safely special-case `err instanceof AIProviderError` from `runRetrieval` and yield the same shape of `error` event the chat-completion path does; any other error (e.g. the plain `Error` `lib/retrieval/search.ts` throws if the `match_document_chunks` RPC call itself fails) is a genuinely unexpected failure and is left to propagate to the route handler's catch-all, unchanged.

## Chunking (`lib/ingestion/chunk.ts`)

**Parameters: 650 tokens target, ~78 tokens (12%) overlap**, chunked on sentence/paragraph boundaries (never mid-word or mid-sentence) — a pure function, no I/O, so `chunkText()` is fully unit tested (`lib/ingestion/__tests__/chunk.test.ts`, 10 cases: empty input, single-chunk-sized input, text with no sentence punctuation, overlap correctness, paragraph boundaries, invalid options).

**Why 500-800 (middle: 650) tokens, ~10-15% overlap:**
- Below ~500 tokens, chunks are often sub-paragraph fragments that lose surrounding context a model would need to answer confidently (e.g. a refund *amount* without the *condition* it applies to, split into separate chunks).
- Above ~800 tokens, a chunk starts mixing multiple topics/sub-sections, which dilutes its embedding (a vector that's "a bit about everything" matches everything a bit, i.e. worse discrimination in top-k search) and wastes context budget on parts of the chunk that aren't relevant to the specific question.
- The overlap (~12%) exists so a fact sitting right at a chunk boundary in the source document isn't split across two *disjoint* chunks with neither one containing the whole sentence — 10-15% is enough to carry the last sentence or two of context forward without meaningfully increasing embedding cost (the accepted trade-off is: a bit of duplicate content across neighboring chunks vs. losing exact-boundary facts).

Token size is *estimated*, not billed, via a `chars/4` heuristic (`lib/tokens.ts`) — good enough to size chunks consistently across providers/models without adding a tokenizer dependency; **actual billed tokens always come from the provider's own API response** (`ChatStreamResult.usage`, logged to `usage_events`), never from this estimate.

### Chunking + retrieval quality: "question → expected source"

No real AI provider API key is available yet in this environment (see below), so `lib/testing/keyword-embeddings.ts` — a deterministic bag-of-words hashing pseudo-embedding — stands in for a real model in `lib/retrieval/__tests__/chunking-quality.integration.test.ts`. It captures keyword overlap, not real semantic similarity, so this proves the **retrieval mechanics** (chunk boundaries survive ingestion, cosine-similarity ranking via `match_document_chunks`, per-user scoping) work correctly end to end against a real Postgres/pgvector instance — it is *not* a substitute for validating actual semantic retrieval quality with a real embedding model once keys are available. The three cases (run for real, not just described — see that file):

| Question | Expected source | Result |
|---|---|---|
| "How many days do I have to return an item for a refund?" | *Return & Refund Policy.pdf* (chunk: "...within 30 days of delivery...") | ✅ top match |
| "What happens on my first day as a new employee?" | *Employee Onboarding Guide* (chunk: "Welcome to the team! On your first day...") | ✅ top match |
| "Is security training mandatory for new hires?" | *Employee Onboarding Guide* (chunk: "All new hires complete a mandatory security training...") | ✅ top match |

Source content is the same text as the two demo documents in `supabase/seed.sql`.

## Ingestion (`lib/ingestion/ingest.ts`)

Accepts `{ documentId, userId, title, text }` (already normalized — this module never fetches from Notion/URL/Drive/disk; that's `document-sources-specialist`'s job) and runs: verify the document belongs to `userId` → `documents.processing_status = 'processing'` → chunk → embed (batched, via the active `EmbeddingsProvider`) → **delete all existing chunks for this `document_id`, then insert the new set** → `processing_status = 'ready'` (or `'error'` with `processing_error` set, on any failure).

The delete-before-insert step is **required, not an optimization**: it's what makes clicking "Refresh" on a Notion page or Drive file idempotent. Without it, a document that shrinks from 10 chunks to 6 on re-ingest would leave `chunk_index` 6-9 behind from the previous version, and `match_document_chunks` would keep returning that stale content forever (see the `document_chunks` migration's table comment, which spells out this exact failure mode). Verified against a real database, not just mocked, in `lib/ingestion/__tests__/ingest.integration.test.ts`'s "re-ingesting deletes the old chunk set" test.

`page_number` is left `null` for every chunk today: the normalized-document contract (`{ title, text, sourceType, sourceRef }`) is a flat string with no page markers. Only `chunk_position` (ordinal) is populated. If `document-sources-specialist` starts passing page boundaries through for PDF sources, `ingest.ts` is where that would get wired into `page_number`.

## Retrieval (`lib/retrieval/search.ts`)

`runRetrieval(question, userId, deps, options)`: embeds the question via the active `EmbeddingsProvider`, calls the `match_document_chunks` RPC (top-k, default 6) via a **service-role** Supabase client, and assembles a token-budgeted context (default cap: 3000 estimated tokens — see `lib/tokens.ts`) — most-similar-first, stopping before the next chunk would exceed the budget (always including at least one chunk even if it alone is over budget, since an empty context is worse). Returns both the formatted context text *and* the list of sources that actually made it in (document id/title, source type, page/position, similarity) — this is what gets attached to `messages.sources` and is what the frontend renders as "based on document X", not something it has to reverse-engineer from the answer text.

**Security-critical detail, spelled out because it's easy to regress silently:** `match_document_chunks` is `security definer` and `EXECUTE` is granted **only to `service_role`** (see the RPC migration) — it trusts `p_user_id` completely and does not re-derive it from RLS. `runRetrieval` is called exclusively from server code (`app/api/chat/route.ts`) with a `userId` that comes from `lib/supabase/server-client.ts`'s `getAuthenticatedUser()`, which itself calls Supabase's `auth.getUser()` (revalidates the JWT against the auth server, not a locally-decoded cookie). **No code path in this project accepts a `userId`/`p_user_id` from a request body or query string.** This is verified against the real RPC (not mocked) in `lib/retrieval/__tests__/search.integration.test.ts`: two real users, one document each, one user's document holding a *perfect vector match* to the other user's query — and asserting it never shows up in the other user's results.

## System prompt (`lib/retrieval/system-prompt.ts`)

One `RAG_SYSTEM_PROMPT` constant, used identically regardless of `AI_PROVIDER` (plain instruction text, no provider-specific tool syntax). Core rule: answer only from the provided context; if the context doesn't contain the answer, say so plainly rather than falling back to the model's own training knowledge. Injected into the chat call as `${RAG_SYSTEM_PROMPT}\n\nКонтекст:\n${assembledContext}` (see `lib/chat/handle-chat-request.ts`).

## Chat pipeline & API route

Split into two layers on purpose:

- **`lib/chat/handle-chat-request.ts`** — framework-agnostic core: resolve/create a conversation, persist the user message, run retrieval, stream the answer, persist the assistant message + sources + `usage_events`. An async generator yielding `{ conversation | sources | delta | done | error }` events. No Next.js/HTTP knowledge — this is what makes it unit-testable with fakes (`lib/chat/__tests__/handle-chat-request.test.ts`) without a running server.
- **`app/api/chat/route.ts`** — thin HTTP adapter: authenticates the request (`getAuthenticatedUser`), checks the rate limit (see below — **before** any AI-provider call, returning a real `429` + `Retry-After` header if exceeded, not a `200` stream carrying an error event), then turns `handleChatRequest`'s events into a Server-Sent-Events response.

**Request/response contract** (for `nextjs-frontend` to build against):

```
POST /api/chat
body: { conversationId?: string; message: string }

401 { error: "unauthorized" }                                  -- no valid session
400 { error: "invalid_request", details }                      -- malformed body (zod)
429 { error: "rate_limited", message, retryAfterMs }            -- Retry-After header set, in seconds
200 Content-Type: text/event-stream                             -- success; body is a sequence of:
  event: conversation
  data: {"type":"conversation","conversationId":"..."}          -- always first; id for follow-up requests

  event: sources
  data: {"type":"sources","sources":[{ chunkId, documentId, documentTitle, sourceType, sourceRef, pageNumber, chunkPosition, similarity }, ...]}

  event: delta
  data: {"type":"delta","text":"..."}                            -- repeated, in order; concatenate for the full answer

  event: done
  data: {"type":"done","usage":{"promptTokens":N,"completionTokens":N,"totalTokens":N}}

  -- OR, instead of `done`, if generation fails after streaming started:
  event: error
  data: {"type":"error","message":"...","retryable":true|false}
```

Streaming uses the Vercel AI SDK's `streamText` internally (via each `ChatProvider` adapter), but the HTTP-level framing to the client is this project's own small SSE envelope (not the AI SDK's default UI-message protocol) specifically so it can carry the `sources`/`conversation` events alongside text — a custom, versioned, and fully documented contract the frontend can consume with a plain `fetch` + `ReadableStream` reader (or any SSE parser), independent of which `@ai-sdk/react` version ends up in use later.

## Rate limiting & cost control (`lib/rate-limit/rate-limiter.ts`)

Backed by the existing append-only `usage_events` table (db-architect's design — an event log + `COUNT(*)` over a time window, not a shared counter column, so concurrent requests can't race on a lost update; see that migration's "Atomicity note"). **Not** Vercel KV/Upstash: the project already has a Postgres table purpose-built for this, with an index (`user_id, created_at desc`) sized exactly for this query — adding a second stateful dependency for the same job wasn't worth it here.

`checkChatRateLimit(supabase, userId, { maxRequests: 10, windowMs: 60_000 })` (defaults) counts the user's `chat_request` events in the trailing window. On its own this has a real gap: a request's `chat_request` `usage_events` row isn't written until *after* its full streamed response finishes (seconds later, see `lib/chat/handle-chat-request.ts`), so `N` requests fired in parallel would all query the same too-low `COUNT(*)` and all pass a check that's individually correct but collectively bypassable — the cheapest way to run up an AI provider bill, and a direct violation of CLAUDE.md's "checked server-side, before calling the AI provider" rule if left unfixed.

**Fix: `reserveChatRateLimitSlot(supabase, userId, config)`** — what `app/api/chat/route.ts` actually calls, not `checkChatRateLimit` directly. It runs the same DB count, then adds an **in-process reservation**: a per-user, in-memory timestamp list of requests that have passed the check and started processing but haven't (yet, or ever) written their own `usage_events` row. The combined count (`DB rows` + `active reservations`) is what's checked against `maxRequests`, and — critically — the reservation is written *synchronously*, in the same tick the DB count resolves, with no further `await` in between; JS's single-threaded event loop means no other concurrent call for the same user can interleave inside that span, so two callers can never both observe a stale count and both reserve past the limit. `reserveChatRateLimitSlot` returns a `release()` function that `app/api/chat/route.ts` calls once the SSE stream is fully done (success or failure), in a `finally` block, freeing the slot (on success the real `usage_events` row has already landed by then; on failure no row is ever written, so the reservation was the only thing counting that attempt).

Why not a DB-persisted "pending" row instead of in-memory state: `usage_events` is deliberately append-only (service_role has `SELECT`+`INSERT` only, no `UPDATE`/`DELETE` at all — see the table migration's grants), specifically so nothing can mutate/erase rate-limit history. Turning a reservation into a real row, or clearing a failed one, needs `UPDATE`/`DELETE` — a schema/grant change that's `db-architect`'s call, not something this module should route around unilaterally. The in-memory layer is the explicit MVP-scoped tradeoff instead:

- ✅ Fully closes the burst race **within one Node process/instance** — verified with a concurrency test (`lib/rate-limit/__tests__/rate-limiter.test.ts`, "counts N concurrent requests against each other... exactly maxRequests are allowed, not all of them" — 5 parallel calls against a limit of 3 correctly yield exactly 3 `allowed`, not 5) and confirmed by demonstrating the opposite: the *same* concurrency test run against the old `checkChatRateLimit` alone (no reservation) lets all 5 through, proving this isn't a test that would pass regardless.
- ⚠️ Does **not** protect against a burst spread across multiple serverless instances (e.g. Vercel scaling out multiple Node processes for the same deployment under load) — each instance has its own `activeReservations` map. In that scenario the DB-only check is still the backstop, so the limit degrades from "hard N/window" to "hard N/window per warm instance, roughly N/window in practice for a lightly-scaled demo" rather than being fully bypassable — but it is a known, real gap for production multi-instance deployment, not silently claimed to be solved. Closing it fully would mean either a DB-persisted pending-row scheme (needs the schema/grant change above) or a shared store (Upstash/Vercel KV) — worth revisiting if/when this deploys behind more than one warm instance.

Verified against fakes (`lib/rate-limit/__tests__/rate-limiter.test.ts`, including the burst/release/idempotent-release cases above) and against the real table (`lib/rate-limit/__tests__/rate-limiter.integration.test.ts` — `embedding_request` events and other users' events don't leak into the count).

Separately, `lib/retrieval/search.ts`'s context token budget (default 3000 estimated tokens) bounds how much retrieved content gets attached to a single request regardless of how many documents a user has, and the chat API's request body caps the question itself at 4000 characters (zod `.max(4000)`) independent of that context budget.

Token usage (input/output, separately) and which provider/model served each request are logged to `usage_events` for every successful chat completion, and (as a best-effort *estimate*, not billing-accurate — `EmbeddingsProvider.embed()` doesn't return usage) for every retrieval embedding call — enough to compare provider cost/performance and estimate demo running cost once real usage accumulates.

## `.env.example`

Placeholders for every provider this project supports, even ones not used by the default demo config: `AI_PROVIDER`, `OPENAI_API_KEY` (+ optional model overrides), `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `GEMINI_API_KEY`, plus `NOTION_API_KEY`/`GOOGLE_SERVICE_ACCOUNT_JSON` reserved for `document-sources-specialist`, and the three Supabase vars. See the file itself for per-var comments.

## What's been verified live vs. what hasn't

**No real AI provider API keys (OpenAI/Anthropic/Voyage/Gemini) are available in this environment yet** — the user will add them later. Everything AI-provider-facing has been written and reviewed against each SDK's actual TypeScript types (installed from npm, not guessed), but **not exercised against a live API call**. Specifically:

- ✅ **Verified against a real, running Supabase/Postgres/pgvector instance** (`npm run test:integration`, 11 tests): the `match_document_chunks` RPC's cross-tenant isolation and similarity ordering (with deterministic fabricated vectors), the rate limiter against the real `usage_events` table, the ingestion pipeline's delete-before-insert re-sync behavior against real `documents`/`document_chunks` rows, and the chunking+retrieval "question → source" quality examples above (with a toy keyword embedding standing in for a real model).
- ✅ **Verified with fast unit tests against fakes** (`npm test`, 77 tests): chunking edge cases, the AI-provider error normalizer, the retry/backoff logic (including the retry-before-first-token bug the tests caught), embedding batch bisection, the rate limiter's query logic, the retrieval context-assembly/token-budget logic, and the full chat request pipeline (conversation creation/reuse, message persistence, provider-failure handling).
- ⚠️ **Not yet verified**: an actual OpenAI/Anthropic/Voyage/Gemini API call — i.e. that `OpenAICompatibleProvider`/`AnthropicChatProvider`/`VoyageEmbeddingsProvider`'s request shapes are accepted by the real APIs, that `createGeminiProvider`'s reuse of the OpenAI-compatible endpoint actually round-trips against `generativelanguage.googleapis.com`, that real usage/token numbers come back in the expected shape, and that 429/5xx retry behavior triggers correctly against real rate limits rather than fabricated error objects. **This is the first thing to check once API keys are added** — set `AI_PROVIDER` + the matching key(s) in `.env.local`, then try a real `POST /api/chat` request (once `nextjs-frontend` exists, or via `curl`) against a document ingested with `ingestDocumentWithDefaultProviders`. Only two of the three providers need to be confirmed working per the project's own review bar (CLAUDE.md/qa-reviewer) — start with `openai` (cheapest/most predictable) and one of `anthropic`+Voyage or `gemini`.

## Project boundaries (this agent's scope)

Per `CLAUDE.md`, this part of the project (`rag-pipeline-specialist`) does **not** build: document source adapters (`lib/sources/*` — Notion/URL/Drive/manual upload, SSRF protection, Storage upload), the frontend/UI, or database migrations. It also doesn't create Supabase Auth users/sessions for real end users — `getAuthenticatedUser()` expects a session that already exists (via whatever sign-in flow `nextjs-frontend` builds); for now it's been exercised in tests against users created directly via the Supabase admin API.
