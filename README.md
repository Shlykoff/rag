# RAG Assistant

[![CI](https://github.com/Shlykoff/rag/actions/workflows/ci.yml/badge.svg)](https://github.com/Shlykoff/rag/actions/workflows/ci.yml)
[![ko-fi](https://img.shields.io/badge/Ko--fi-FFDD00?style=for-the-badge&logo=ko-fi&logoColor=black)](https://ko-fi.com/shlykoff)

An AI assistant with retrieval-augmented generation (RAG) over your own documents — uploaded files, Notion pages, public URLs, and a Google Drive folder — with a provider-independent AI layer (OpenAI / Anthropic+Voyage / Gemini, switchable per project) and sources cited under every answer.

Full spec: [`docs/spec.md`](docs/spec.md). Architectural ground rules: [`CLAUDE.md`](CLAUDE.md).

## What this is

Documents live inside **projects** — a user can own several, each with its own document set, its own active AI provider, its own in-app test chat, and its own external channel integration (Telegram). People messaging a project's Telegram bot are that project's audience, not app users: they never get a Supabase account.

Each signed-in user connects their own AI-provider API key(s) (bring-your-own-key, encrypted at rest) and picks which connected provider each of their projects uses. There is no live deploy yet; run it locally per below.

## Stack

Next.js (App Router, TypeScript strict) · pluggable AI-provider layer (OpenAI / Anthropic+Voyage / Gemini) · Supabase Postgres + `pgvector` + Storage · Vercel AI SDK (`ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`) for streaming · Vitest for tests.

## Running locally

Requires Docker (for local Supabase) and Node **22+** (see `.nvmrc` — `nvm use`); this project's Supabase/AI dependencies need native Node 22 features.

```bash
git clone <repo>
cd RAG
nvm use                 # Node 22
npm install

supabase start           # local Supabase in Docker; prints local URL/keys
cp .env.example .env.local
# fill in NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY /
# SUPABASE_SERVICE_ROLE_KEY from the `supabase start` output, plus
# CREDENTIALS_ENCRYPTION_KEY (`openssl rand -hex 32`) and at least one AI
# provider's API key (OPENAI_API_KEY / ANTHROPIC_API_KEY+VOYAGE_API_KEY /
# GEMINI_API_KEY) for the required seed step below.

npm run seed:ai-keys      # REQUIRED. AI provider selection is per-user/
                           # per-project now, not a global env var read at
                           # request time -- this script is what seeds the
                           # demo account's own encrypted credentials (and
                           # its demo project's active provider) from
                           # .env.local. Safe to re-run any time, e.g.
                           # after every `supabase db reset`.

npm run dev               # http://localhost:3000
```

Skipping `npm run seed:ai-keys` leaves the seeded demo account with zero configured providers, so its first chat message gets the same `422 { error: "no_credentials" }` (and "add a key" modal) as any brand-new user.

Open `http://localhost:3000/login` and click **"Попробовать демо"** to sign in as the seeded demo account (`demo@example.com` / `demo-password-123`, created by `supabase/seed.sql` — hardcoded for local dev only, skipped when pushing to a hosted project) with two pre-ingested documents already `ready`.

### Tests

```bash
npm test                  # fast unit tests, no Docker required
npm run test:integration  # requires `supabase start` first -- runs against
                           # the real local Postgres/pgvector. Needs Node
                           # 22+ specifically -- @supabase/supabase-js's
                           # realtime client throws on Node 20 ("native
                           # WebSocket not found").
```

**CI** (`.github/workflows/ci.yml`, every push/PR to `main`): type check → lint → `npm test` → `next build` (placeholder env vars, no real network calls at build time). Integration tests do **not** run in CI (no Docker on GitHub-hosted runners) — run them locally instead.

`npm test` never touches a database — everything runs against fakes. `npm run test:integration` loads `.env.local` and runs `*.integration.test.ts` files against your local `supabase start` instance: real inserts, a real `match_document_chunks` RPC call, real cross-tenant isolation checks. It's a separate Vitest config (`vitest.integration.config.mts`) so plain `npm test`/CI never needs Docker.

## Architecture: the AI provider abstraction (`lib/ai/`)

Business logic (retrieval, the chat API route, ingestion) never imports `openai`, `@ai-sdk/*`, or `voyageai` directly — only `lib/ai/index.ts`'s `getAIProviders({ projectId, ownerUserId }, supabase)`, which returns a `{ chatProvider, embeddingsProvider }` pair.

Two interfaces (`lib/ai/types.ts`):

```ts
interface ChatProvider {
  providerName: string;
  modelName: string;
  streamChat(input: { systemPrompt: string; messages: ChatMessage[] }): ChatStreamResult;
}
interface EmbeddingsProvider {
  providerName: string;
  modelName: string;
  dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}
```

`PROVIDER_REGISTRY` is the single source of truth for which providers exist:

| Provider | Chat | Embeddings | Notes |
|---|---|---|---|
| `openai` | `gpt-4.1-mini` via `@ai-sdk/openai` streaming | `text-embedding-3-small`, `dimensions: 1024` | default |
| `anthropic` | `claude-sonnet-4-5` via `@ai-sdk/anthropic` streaming | Voyage `voyage-3-large`, `outputDimension: 1024` | Anthropic has no embeddings API — Voyage is a fixed pairing, not independently selectable |
| `gemini` | `gemini-3.6-flash` | `gemini-embedding-001`, `dimensions: 1024` | reuses the same OpenAI-Chat-Completions-compatible client as `openai` (`createOpenAICompatiblePair()`), pointed at Google's official OpenAI-compatible endpoint via a different `baseURL`/`apiKey`/`model` |

Adapters (`lib/ai/providers/{openai,anthropic,voyage,gemini}.ts`) wrap the Vercel AI SDK for chat streaming and the raw `openai`/`voyageai` SDKs for embeddings. Each returns two distinct, independently-labeled `chatProvider`/`embeddingsProvider` views over one shared HTTP client rather than one dual-interface object — `chatProvider.modelName` and `embeddingsProvider.modelName` are semantically different fields that must never be confused (this is what `document_chunks.embedding_model` records per row).

**1024 dimensions everywhere.** All three providers are pinned to 1024-dimensional vectors, matching `document_chunks.embedding vector(1024)`. This isn't arbitrary: Voyage (`voyage-3-large`/`voyage-4`, used for `anthropic`'s embeddings) only accepts `output_dimension` from `{256, 512, 1024, 2048}` — 1536 isn't in that set — and 1024 is Voyage's own default. OpenAI and Gemini both support truncating their native embedding output down to an arbitrary dimension, including 1024, so this is the one value usable by all three behind a single `vector(1024)` column with no migration needed on provider switch.

**Switching a provider requires re-ingesting documents.** Different embedding models produce incompatible vector spaces even at equal dimensionality — this is expected behavior, not a bug. `document_chunks.embedding_provider`/`embedding_model` record which provider/model produced each row, so a provider switch's "which documents need re-embedding" question has a real SQL answer.

### Bring-your-own-key credentials (`lib/ai/credentials.ts`, `app/api/profile/ai-providers/route.ts`)

Each signed-in user stores their own API key(s), encrypted at rest, and each **project** independently picks which of that user's connected providers it uses:

- **`ai_provider_credentials`** — one encrypted row per `(user_id, provider)`, account-level. `provider ∈ {openai, anthropic, gemini, voyage}`; Voyage is a full independent row, since "Anthropic fully configured" means both an `anthropic` row and a `voyage` row exist.
- **`projects.active_ai_provider`** — nullable, project-level, `CHECK`ed to never be `'voyage'`. `setActiveProvider()` refuses to activate a provider whose credential(s) aren't connected yet (`MissingProviderCredentialsError` → `400`), so this column can never point at something unusable.
- **`app/api/profile/ai-providers/route.ts`** (account-level: connect/check/remove a key) and **`app/api/projects/{projectId}/model/route.ts`** (project-level: read/set which connected provider this project uses) are deliberately two separate routes — "connect a provider" is a user action, "which connected provider a project uses" is a per-project selection. The plaintext key is never echoed back, logged, or returned by `GET` — only booleans.
- `getAIProviders()` throws `AIProviderError{kind:"no_credentials"}` (never a bare error) when a project has no active provider, or its owner's credential for that provider was deleted after being made active — callers map this to a clean `422`, not a `500`.

### Credential encryption (`lib/crypto/secret-box.ts`)

AES-256-GCM (Node's built-in `crypto`), keyed by `CREDENTIALS_ENCRYPTION_KEY` (env var only, never in the DB, never in the client bundle — generate with `openssl rand -hex 32`). Being an AEAD cipher, tampered/corrupted ciphertext fails to decrypt loudly rather than silently returning garbage. Every module carries `import "server-only"` so an accidental client-bundle import fails the build.

Three call sites store the same *kind* of secret under the same threat model — a user's AI-provider API key (`lib/ai/crypto.ts`), a Notion/Google Drive credential (`lib/sources/crypto.ts`), a Telegram bot token (`lib/channels/telegram/crypto.ts`) — so all three are thin, domain-named re-exports of one shared `lib/crypto/secret-box.ts` implementation rather than three copies. `lib/crypto/` is a neutral module none of `lib/ai/`/`lib/sources/`/`lib/channels/` owns, so importing it doesn't create a cross-domain dependency between those (`lib/channels/**`'s enforced import boundary, see below, specifically allows this). Not Supabase Vault: Vault's KMS-backed key differs between local Docker Supabase and hosted Supabase, which would make "does decryption still work after `supabase db push`" a real risk — application-level encryption keeps the key fully outside the database and consistent across environments.

Nowhere in the codebase is a plaintext credential ever logged or returned by a `GET` — every credential-bearing route/table exposes only a `configured: boolean`.

### Error handling (`lib/ai/errors.ts`, `lib/ai/retry.ts`, `lib/ai/stream-utils.ts`)

`normalizeProviderError()` duck-types every vendor SDK's error shape into one `AIProviderError { kind, retryable, userMessage, status }`, so nothing outside `lib/ai/` branches on a vendor-specific error class.

- **Embeddings** (non-streaming): `withRetry()` — exponential backoff + jitter, retries `429`/`5xx`/network errors, gives up after 3 attempts. Each provider SDK's own retry is disabled (`maxRetries: 0`) so there's exactly one retry policy.
- **Chat streaming**: `wrapAiSdkStream()` retries only *before* the first token is yielded to the caller — once any text has streamed, retrying would duplicate or garble content a UI may have already rendered.
- **Embedding batches** (`lib/ai/embed-batch.ts`): batched, and if a whole batch fails, bisects it to isolate exactly which input(s) are the problem — one bad chunk doesn't fail every other input in that batch.
- Both `runRetrieval()`'s embedding call and `chatProvider.streamChat()` failures get the same normalize-and-yield treatment inside `handleChatRequest`, so an embeddings 429 gets an accurate `retryable` flag instead of the API route's catch-all hardcoding `false`.

## Chunking (`lib/ingestion/chunk.ts`)

**650 tokens target, ~12% overlap**, split on sentence/paragraph boundaries (never mid-word). Token size is *estimated* via a `chars/4` heuristic (`lib/tokens.ts`) — good enough to size chunks consistently without a tokenizer dependency; actual billed tokens always come from the provider's own API response.

Why this range: below ~500 tokens, chunks are often sub-paragraph fragments missing the context a model needs to answer confidently. Above ~800 tokens, a chunk mixes multiple topics, diluting its embedding and wasting context budget. The ~12% overlap keeps a fact sitting at a chunk boundary from being split across two disjoint chunks.

`lib/testing/keyword-embeddings.ts` (a deterministic bag-of-words pseudo-embedding) lets `lib/retrieval/__tests__/chunking-quality.integration.test.ts` verify retrieval *mechanics* (chunk boundaries survive ingestion, cosine-ranking via `match_document_chunks`, per-project scoping) against a real Postgres/pgvector instance with no AI provider key or network call needed.

## Ingestion (`lib/ingestion/ingest.ts`)

Accepts `{ documentId, projectId, ownerUserId, title, text }` (already normalized — this module never fetches from Notion/URL/Drive/disk) and runs: verify the document belongs to `projectId` → `processing_status = 'processing'` → chunk → embed (batched, via the project's active `EmbeddingsProvider`) → **delete all existing chunks for this document, then insert the new set** → `processing_status = 'ready'` (or `'error'` with `processing_error` set).

Delete-before-insert is required, not an optimization: it's what makes clicking "Refresh" idempotent. Without it, a document that shrinks from 10 chunks to 6 on re-ingest would leave stale `chunk_index` 6–9 behind, and `match_document_chunks` would keep returning that orphaned content forever.

`page_number` is left `null` for every chunk today — the normalized-document contract is a flat string with no page markers; only `chunk_position` (ordinal) is populated.

## Document sources (`lib/sources/`)

Four adapters behind one `DocumentSource`/`NormalizedDocument` contract (`lib/sources/types.ts`) — `{ title, text, sourceType, sourceRef }`. None of them chunk or embed anything; `lib/sources/pipeline.ts` is the one place that writes to `documents`, uploads to the private `documents` Storage bucket, and calls the shared ingest pipeline.

| Source | Adapter | Auth | Notes |
|---|---|---|---|
| Manual upload | `lib/sources/manual-upload.ts` | none | PDF/markdown/txt, 20MB cap. Original file bytes are stored (`original.<ext>`) — no separate cached-text object. |
| Notion | `lib/sources/notion.ts` | Internal Integration Secret, encrypted per-user | Page or database by URL/id via `@notionhq/client`. Nested blocks/sub-pages followed up to 3 levels deep. Database import capped at 200 rows, first data source only. |
| Public URL | `lib/sources/url.ts` + `lib/sources/net/safe-fetch.ts` | none | SSRF-guarded fetch + `@mozilla/readability`/`jsdom` main-content extraction. |
| Google Drive folder | `lib/sources/google-drive.ts` | Service Account JSON, encrypted per-user | One folder id, no recursion into subfolders, via `googleapis`. |

### API routes (`app/api/sources/`)

- `POST /api/sources/upload` — multipart `file` field.
- `POST /api/sources/credentials` `{ sourceType: "notion"|"google_drive", credential }` / `GET` — save (encrypted) or check connection status. `GET` returns only `{ notion: boolean, google_drive: boolean }`.
- `POST /api/sources/notion` `{ pageUrl }`, `POST /api/sources/url` `{ url }`, `POST /api/sources/google-drive` `{ folderId }` — all **upsert** by `(project_id, source_type, source_ref)`, so re-submitting the same page/URL/folder updates the existing document instead of duplicating it.
- `POST /api/sources/{documentId}/refresh` — re-fetches from the document's recorded `source_ref` and re-runs ingest. `manual_upload` documents get `400` (nothing external to refresh).

Errors are normalized through `lib/sources/errors.ts`'s `SourceError` and mapped to HTTP status codes (401 unauthorized, 403 "not shared", 400 bad input/SSRF-blocked, 422 empty content, 502 unclassified upstream failure).

### SSRF protection (`lib/sources/net/safe-fetch.ts`, `lib/sources/net/ip-guard.ts`)

The most security-critical code in the project — a user-supplied URL that the server fetches on their behalf is the textbook SSRF vector. Full reasoning lives in `safe-fetch.ts`'s module header; summary:

- **Scheme allowlist**: only `http`/`https` — `file://`, `ftp://`, `data:`, `gopher://`, etc. rejected before any I/O.
- **IP-range check** (`ip-guard.ts`, built on Node's `net.BlockList`): blocks `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (includes the `169.254.169.254` cloud-metadata address), plus `0.0.0.0/8` and `100.64.0.0/10` (carrier-grade NAT — same risk category), and the IPv6 equivalents (`::1`, `fe80::/10`, `fc00::/7`) including IPv4-mapped forms and AWS's IPv6 metadata prefix. Invalid/unparseable input is treated as blocked — fail closed.
- **The same lookup that validates an address is what the socket connects to.** A literal-IP URL (e.g. `http://169.254.169.254/...`) is checked directly, since Node's http/net internals skip the custom DNS `lookup` hook entirely for a host that's already a literal IP. A hostname is resolved via a custom `lookup` function that validates every resolved address and *is itself* what the socket dials — never a separate "check, then let the client re-resolve" step, which would reopen a DNS-rebinding bypass (a malicious resolver can legitimately answer one query with a public IP and the next with a private one).
- **Every redirect hop is followed manually and re-validated from scratch** — never handed to automatic redirect-follow, closing the classic gap where a guard checks the typed URL, then lets the client silently follow a `302` into a private address.
- **Timeout** (10s default, per hop) and **response-size cap** (10MB default), enforced by destroying the socket mid-stream the instant the cap is exceeded, not after downloading everything.

Tested in `lib/sources/net/__tests__/`: `ip-guard.test.ts` (pure range/boundary tests, no I/O), `safe-fetch.test.ts` (end-to-end against the real, unmocked guard — scheme rejection, blocked-IP URLs over http/https, IPv6-literal and IPv4-mapped cases), `safe-fetch-redirects.test.ts` (the redirect-hop-revalidation mechanism against two real local HTTP servers).

### "Not shared" errors (Notion / Google Drive)

The most common real-world failure for both sources is forgetting to share the page/folder with the integration/service account. Both APIs return a bare, ambiguous error in this case (Notion: `404`, indistinguishable from "doesn't exist" — so a token can't probe for pages it can't see; Google Drive: `403`/`404`, and an empty listing looks the same as an unshared one). The adapters translate these into an explicit, actionable message telling the user which button to click, rather than surfacing the raw status code.

### Manual re-sync only

Every source except `manual_upload` supports re-sync via `POST /api/sources/{documentId}/refresh` (or, for Drive, re-running the folder sync to pick up new files) — only when the user explicitly triggers it. There is no polling, no webhook subscription, no cron job. This is a deliberate MVP boundary: push-based sync would mean standing up webhook endpoints, verifying signatures, and handling out-of-order/duplicate delivery, none of which is needed at this scale.

### MVP boundaries

- **Google Drive**: one folder, no recursion into subfolders (a subfolder is reported `skipped`). Only a *folder* can be shared for first-time import — a directly-shared single file's parent folder isn't visible to the service account at all (no `parents` field on the returned file object), so there's no folder id to use.
- **Notion**: nested blocks/sub-pages followed 3 levels deep; a database import is capped at 200 rows and queries only its first data source.
- **URL/Drive text extraction is UTF-8-only** — a page or file served in a legacy encoding (windows-1251, ISO-8859-1, ...) extracts with mojibake.
- **Manual upload's 20MB cap is application-level, not guaranteed** — a serverless platform's own request-body limit may reject a large upload before it reaches this check. A production fix would be a direct-to-Storage upload flow from the client.
- **`/api/sources/*` rate limiting** is 20 requests/minute/project by default — see "Rate limiting & cost control" below for the in-memory/multi-instance caveat shared by every non-chat limiter in this project.

## Retrieval (`lib/retrieval/search.ts`)

`runRetrieval(question, projectId, deps, options)`: embeds the question via the project's active `EmbeddingsProvider`, calls the `match_document_chunks` RPC (top-k, default 6) via a **service-role** client, and assembles a token-budgeted context (default cap: 3000 estimated tokens) — most-similar-first, always including at least one chunk even if it alone is over budget. Returns both the context text and the sources that made it in, which is what the frontend renders as "based on document X" — not something reverse-engineered from the answer.

**Security-critical detail:** `match_document_chunks` is `security definer` and `EXECUTE` is granted only to `service_role` — it trusts `p_project_id` completely and does not re-derive it from RLS. Every caller must independently verify project ownership *before* calling it: the web chat path verifies via the RLS-scoped session client (`verifyProjectOwnership()`, 404-not-403 on mismatch); the external-channel path (`lib/gateway/answer.ts`) resolves the project owner via its own service-role lookup keyed off the `channel_integrations` row that received the webhook, never off anything in the inbound payload. No code path accepts a `projectId` straight from a request body without that independent check first. Verified against the real RPC in `lib/retrieval/__tests__/search.integration.test.ts`, including cross-project isolation when both projects share the same owner.

## System prompt & chat pipeline

`lib/retrieval/system-prompt.ts`'s `RAG_SYSTEM_PROMPT` instructs the model to answer only from the provided context and say so plainly when it can't. As a code-level backstop (the model doesn't always follow that instruction on an empty-context turn), `lib/chat/handle-chat-request.ts` never calls the chat provider at all when the top retrieved chunk's similarity is below a low threshold — it returns the canned "no information" reply directly, identical in wording to the prompt's own instruction so the two paths are indistinguishable to the user.

Split into two layers:

- **`lib/chat/handle-chat-request.ts`** — framework-agnostic core: resolve/create a conversation, persist the user message, run retrieval, stream the answer, persist the assistant message + sources + `usage_events`. An async generator yielding `{ conversation | sources | delta | done | error }`. Serves both the project owner's own test chat and an external channel participant's turn from one shared code path — the two ownership shapes are distinguished by whether `externalParticipant` is set; `usage_events.user_id` is always the project **owner** either way, since external participants have no account of their own to bill against.
- **`app/api/chat/route.ts`** — thin HTTP adapter for the owner's own test chat: authenticates, verifies project ownership, checks the rate limit (before any AI-provider call), then turns the generator into an SSE response. The parallel entry point for external channel messages is `lib/gateway/answer.ts`.

**Wire contract:**

```
POST /api/chat
body: { projectId: string; conversationId?: string; message: string }

401 { error: "unauthorized" }
400 { error: "invalid_request", details }
404 { error: "not_found" }                    -- projectId missing or not owned by caller (same response for both)
429 { error: "rate_limited", message, retryAfterMs }
422 { error: "no_credentials", message }      -- this project has no active AI provider / credential yet
500 { error: "provider_unavailable", message }
200 text/event-stream:
  event: conversation  data: {"conversationId":"..."}      -- always first
  event: sources       data: {"sources":[{chunkId,documentId,documentTitle,sourceType,sourceRef,pageNumber,chunkPosition,similarity}, ...]}
  event: delta         data: {"text":"..."}                 -- repeated; concatenate for the full answer
  event: done          data: {"usage":{"promptTokens":N,"completionTokens":N,"totalTokens":N}}
  event: error         data: {"message":"...","retryable":true|false}   -- instead of `done`, if generation fails mid-stream
```

## Projects and external channel integrations (Telegram)

A user can own several projects; each has its own documents, active AI provider, in-app test chat, and (optionally) a Telegram integration. `lib/retrieval/`, `lib/chat/`, `lib/ai/credentials.ts`'s active-provider selection, and `lib/rate-limit/` are all scoped by `projectId`. AI-provider credentials and source credentials stay account-level — "connect a provider/source" is a user action, "which connected one a project uses" is per-project.

### The gateway seam (`lib/gateway/answer.ts`)

The **only** function `lib/channels/` is allowed to import from the core RAG stack:

```ts
export interface GatewayAnswerRequest {
  projectId: string;
  channel: string;                 // opaque label, e.g. "telegram"
  externalParticipantId: string;   // e.g. a Telegram chat_id, as text
  message: string;
}
export type GatewayAnswerResult =
  | { kind: "ok"; text: string }
  | { kind: "rate_limited" }
  | { kind: "no_credentials" }
  | { kind: "error" };

export async function answerExternalMessage(req: GatewayAnswerRequest): Promise<GatewayAnswerResult>;
```

Deliberately **non-streaming**: a webhook has no standard "stream partial replies" mechanism, so this drains `handleChatRequest`'s generator into one buffered string. It resolves the project + owner via `service_role` (no Supabase session exists on an inbound webhook), then runs three concurrency layers before calling into the core pipeline.

### Three concurrency layers

1. **Per-project aggregate** (`lib/rate-limit/rate-limiter.ts`, re-keyed to `projectId`) — the real money/quota budget, shared across a project's owner test chat and every external session of it. DB-backed (`usage_events`).
2. **Per-external-participant** (`lib/rate-limit/channel-participant-rate-limiter.ts`) — in-memory, 5/min default, tighter than layer 1 so one abusive participant can't starve the rest of a project's audience.
3. **Per-conversation processing lock** (`lib/rate-limit/conversation-lock.ts`) — mutual exclusion, not a counting window: rejects (doesn't queue) an overlapping message from a participant whose previous turn is still in flight.

All three layers are per-Node-process state (layer 1 has real DB backing for the count itself, only its burst-closing reservation is in-memory). On a multi-instance deployment, two overlapping deliveries for the same participant could theoretically land on different instances and both pass layer 3's check — worst case is a rare duplicate reply to *that one participant*, never a cross-participant or cross-project leak (every layer's key includes `projectId`). Airtight cross-instance serialization would need a DB-backed claim (`pg_advisory_lock`); out of scope for this stage.

### The isolated module (`lib/channels/`)

**Enforced import boundary (CLAUDE.md rule 8):** files under `lib/channels/**` may import `lib/gateway/**` and generic Supabase client helpers — nothing else from `lib/chat/`, `lib/retrieval/`, `lib/ai/`, or `lib/rate-limit/` directly. Exactly one import crosses that boundary in the whole module: `lib/channels/telegram/adapter.ts`'s import of `answerExternalMessage`.

```ts
// lib/channels/types.ts
interface ChannelAdapter {
  readonly channel: string;
  parseIncoming(request: Request, integration: ChannelIntegrationConfig):
    Promise<{ kind: "message"; message: IncomingChannelMessage } | { kind: "ignore" } | { kind: "unauthorized" }>;
  sendReply(message: { replyTarget: unknown; text: string }, integration: ChannelIntegrationConfig): Promise<void>;
}
```

### Telegram (`lib/channels/telegram/`)

- Verifies `X-Telegram-Bot-Api-Secret-Token` via `crypto.timingSafeEqual` (not `===`, to avoid a timing side-channel).
- Claims each inbound `update_id` via `channel_processed_updates`' `insert ... on conflict do nothing` — the composite primary key makes two concurrent deliveries of the same update race-safe.
- Ignores anything that isn't a plain text message (no `.message` at all, or a `.message` with no `.text`) before the gateway is ever called.
- `/start` and `/new` (resets the conversation — `messages` cascades on delete) are handled as static replies that never call the gateway.
- Replies are sent **plain text only** (no `parse_mode`) — an LLM's own output isn't guaranteed to be valid MarkdownV2/HTML.
- `app/api/channels/telegram/[integrationId]/route.ts` **always returns `200`**, regardless of internal outcome — Telegram retries on any non-2xx or slow response, and a "more correct" 4xx/5xx here would just trigger a retry storm on top of an already-slow pipeline.
- `npm run telegram:set-webhook -- --project <id> --token <bot-token> --url <public-https-base>` bootstraps a bot from the CLI. **Local dev needs a public HTTPS tunnel** (ngrok/cloudflared) — Telegram cannot reach `localhost` directly. Group chats are out of scope for this MVP.

No real Telegram bot/account has been exercised end-to-end in this environment (no bot token or public tunnel available) — the webhook path is verified via unit tests (mocked gateway) and integration tests (real Postgres, constructed update payloads). A real end-to-end delivery through a live bot + tunnel remains an action for whoever deploys this.

### Project, model, and channel management routes (`app/api/projects/**`)

```
GET    /api/projects                       -> 200 { projects: ProjectDTO[] }
POST   /api/projects   { name }            -> 201 { project }
GET    /api/projects/{id}                  -> 200 { project } | 404
PATCH  /api/projects/{id} { name }         -> 200 { project } | 404 | 400
DELETE /api/projects/{id}                  -> 200 { projectId, status } | 404 | 500 { error: "storage_cleanup_failed" }

GET  /api/projects/{id}/model              -> 200 { activeProvider, configured }
PUT  /api/projects/{id}/model { provider } -> 200 { activeProvider } | 400 { error: "missing_credentials", provider, missing }

POST/GET/DELETE /api/projects/{id}/channels/telegram   -- connect (registers the webhook via
  Telegram's own setWebhook API), status (live getWebhookInfo check, not a cached flag --
  see below), disconnect
```

`ProjectDTO`: `{ id, name, activeAiProvider, documentCount, createdAt, updatedAt }`.

**Deleting a project** walks the real `"<projectId>/<documentId>/<suffix>"` Storage convention directly (list, then remove every object found) **before** deleting the `projects` row, and leaves the row alone if the sweep fails — once the row is gone, nothing in the app remembers what used to live under that prefix, so a failed cleanup after that point would orphan objects permanently. `ON DELETE CASCADE` alone only removes DB rows, never Storage objects.

**Telegram connection status** is a live call to Telegram's `getWebhookInfo`, not a cached "did setWebhook ever succeed" boolean — a cached flag can go stale (a revoked token, a webhook cleared via BotFather) just as easily as row-existence-only can lie. `GET` reports `connected: false` (no row), or `connected: true` with `webhookStatus: "confirmed"` (Telegram currently has this integration's URL registered) or `"unconfirmed"` (it doesn't, or the live check itself failed).

## Frontend (`app/`, `components/`)

Every protected page lives under `app/(app)/projects/[projectId]/**` except `/projects` itself (the landing page after login) and account-level `/profile`.

- **`/projects`** — list/create/rename/delete, each card showing document count, active-model badge, Telegram-connected badge. Delete requires typing the project's exact name before the button enables.
- **`/projects/[projectId]/{chat,documents,model,channels}`** — a shared sub-nav (`ProjectSubNav.tsx`) verifies project ownership once in the layout (missing-or-not-owned both render the same branded 404); every page below can assume the project is already verified.
  - **`chat`** — the streaming chat UI (`ChatView.tsx`, a hand-rolled SSE parser, `MessageBubble`/`SourceList`), plus a collapsible history panel of this project's own test-chat conversations.
  - **`documents`** — the source-adding UI (tab picker over upload/Notion/URL/Drive forms, each with inline instructions), document list with status badges and a **Refresh** button per document.
  - **`model`** — reads/sets `active_ai_provider`; distinguishes "nothing connected at the account level" (banner pointing at `/profile`) from "a provider is connected but missing a paired credential" (e.g. `anthropic` without `voyage`) from a normal pick.
  - **`channels`** — connect/status/disconnect Telegram, plus a **read-only** list of this project's external-channel sessions with a per-conversation transcript (reusing the chat UI's own message/source components).
- **`/profile`** — three provider cards (OpenAI; Anthropic+Voyage as one card with two key fields; Gemini) plus a read-only summary of which are configured. Never pre-fills a previously-saved key.
- **Citations** render each source under an answer phrased by type ("на основе документа «X»" / "из Notion-страницы «X»" / "со страницы по ссылке X" / "из файла Google Drive «X»"), with a real deep link for `url`/`notion`/`google_drive` sources.
- **`NoProviderModal`** (chat) and **`NoProviderNotice`** (documents page) both react to the same `422 { error: "no_credentials" }` contract and link to this project's `/model` page — a modal in chat (interrupts an in-progress conversation), an inline banner on the documents page (already a dedicated settings screen).
- **Google OAuth sign-in** (`components/auth/GoogleSignInButton.tsx` + `app/auth/callback/route.ts`) is additive alongside the existing demo/email+password flow. The callback exchanges the OAuth code via `@supabase/ssr`'s `exchangeCodeForSession()` and only ever redirects to a fixed allow-list (`/`, `/projects`, `/profile`) — a crafted `?next=` value is never reflected into the `Location` header.
- Every data-loading page ships loading/empty/error states (a `429` renders as "попробуйте через N сек.", not a stack trace; retryable errors get a **Повторить** button).

## Rate limiting & cost control

| Limiter | Scope | Default | Backing |
|---|---|---|---|
| `lib/rate-limit/rate-limiter.ts` | Chat, per project | 10/min | `usage_events` (DB) + an in-process reservation that closes the parallel-burst gap between "check" and the `usage_events` row landing (see below) |
| `lib/rate-limit/source-ingest-rate-limiter.ts` | `/api/sources/*`, per project | 20/min | in-memory sliding window |
| `lib/rate-limit/channel-participant-rate-limiter.ts` | External channel messages, per participant | 5/min | in-memory sliding window |
| `lib/rate-limit/ai-credentials-rate-limiter.ts` | `/api/profile/ai-providers` writes, per user (reused with a `telegram:` key prefix for Telegram connect/disconnect, per project) | 10/min | in-memory sliding window |

`usage_events` is append-only (`service_role` gets `SELECT`+`INSERT` only, no `UPDATE`/`DELETE`) — an event log + `COUNT(*)` over a trailing window, not a shared counter column, so concurrent requests can't race on a lost update.

**The reservation layer, and why it exists:** a request's `chat_request` row isn't written until *after* its full streamed response finishes, seconds later — so N requests fired in parallel would all see the same too-low `COUNT(*)` and all pass. `reserveChatRateLimitSlot()` closes this by adding a synchronous, in-process reservation on top of the DB count, released once the request finishes (success or failure). This fully closes the race within one process/instance, but does **not** share reservations across multiple warm serverless instances — each has its own in-memory map, so the limit degrades to "hard N/window per instance" rather than being bypassable outright (the DB count is still a real backstop). The three in-memory-only limiters above share the same honest multi-instance caveat. Closing any of these fully would mean either a DB-persisted pending-row scheme or a shared store (Upstash/Vercel KV) — not needed at this project's scale.

Separately, `lib/retrieval/search.ts`'s context budget (3000 estimated tokens) bounds how much retrieved content attaches to one request, and the chat request body caps a single question at 4000 characters. Token usage and which provider/model served each request are logged to `usage_events` for every chat completion and (as a best-effort estimate) every retrieval embedding call.

## `.env.example`

Placeholders for every provider this project supports: `AI_PROVIDER`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `GEMINI_API_KEY` (plus optional model-override vars), `NOTION_API_KEY`/`GOOGLE_SERVICE_ACCOUNT_JSON` (local-dev fallbacks only — the real per-user flow is `POST /api/sources/credentials`), `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID`/`_SECRET` (Google OAuth sign-in, optional), `CREDENTIALS_ENCRYPTION_KEY`, and the three Supabase vars.

`AI_PROVIDER`/`*_API_KEY` are kept for exactly one purpose: they feed `npm run seed:ai-keys`, which is how the seeded demo account gets its own per-user credentials at setup time. The running app never reads them at request time — every user's chat/ingestion runs on their own `ai_provider_credentials` row and their project's `active_ai_provider`. There is no global Telegram env var: bot tokens/webhook secrets are per-project, DB-stored (`channel_integrations`), connected via the app or `scripts/telegram-set-webhook.ts`.

## How to test each source manually

- **Manual upload**: `POST /api/sources/upload` with a multipart `file` field (PDF/`.md`/`.txt`). Returns `201 { documentId, chunkCount, status: "ready" }`.
- **Notion**: create an integration at [notion.so/my-integrations](https://www.notion.so/my-integrations), copy its secret, `POST /api/sources/credentials` `{ "sourceType": "notion", "credential": "<secret>" }`, then on the target page use **`···` → `Add connections`** (not the `Share` button) to connect the integration, then `POST /api/sources/notion` `{ "pageUrl": "<url>" }`.
- **Public URL**: `POST /api/sources/url` `{ "url": "https://example.com" }`. Test the SSRF guard with `{ "url": "http://169.254.169.254/" }` — should return `400 ssrf_blocked` immediately.
- **Google Drive**: create a service account, download its JSON key, `POST /api/sources/credentials` `{ "sourceType": "google_drive", "credential": "<minified JSON>" }`, share a Drive **folder** (not a single file) with the service account's `client_email` (Viewer), then `POST /api/sources/google-drive` `{ "folderId": "<id>" }`. Returns `{ imported: [...], skipped: [...] }`.
- **Refresh**: `POST /api/sources/{documentId}/refresh` on any of the above and confirm `last_synced_at` advances.

## Deployment

Hosted on Vercel, database on a hosted Supabase project. Every push to `main` builds and deploys automatically; `supabase/migrations/*.sql` are applied to the hosted database as the last step of that same build (`scripts/apply-production-migrations.mjs`, after `next build` succeeds, not before) — nothing to run by hand.

### Rolling back a bad deploy

**If the deploy touched the database (added a migration): use `git revert`, not Vercel's "Instant Rollback" button.**

Vercel's Instant Rollback just re-points the live domain at an already-built artifact — it does not touch git, and it does not re-run the migration script. `main` keeps pointing at the bad commit, so the rollback only exists in Vercel's dashboard state; the next ordinary push to `main` moves production forward again, potentially straight back through the bug. It also can't undo a migration that already ran.

1. Find the commit that introduced the problem: `git log --oneline`.
2. `git revert <commit>` (add `-m 1` if it's a merge commit). If the bad commit added a migration that needs undoing, write a new migration file in the same commit/PR that reverses it (a plain `ADD COLUMN`/`CREATE TABLE` is trivially safe to reverse this way; a `DROP COLUMN` or a data-mutating migration may not be — see CLAUDE.md rule 9 on writing migrations backward-compatibly in the first place, so this case is rare).
3. Push the revert as a normal branch + PR (branch protection on `main` requires this — no direct pushes). Let CI run: both `lint-and-test` and `integration-tests` (the latter runs the reverted migration against a genuinely fresh Postgres instance, catching a bad revert before it ships).
4. Merge once green. The revert deploys through the normal pipeline — code and any corrective migration land in the same build, in order (build, then migration).

**If it's a pure code bug with no migration involved and every second counts**, Vercel's Instant Rollback (dashboard → Deployments → pick a previous one → "Promote to Production") is fine as an immediate stop-gap. But do the `git revert` right after anyway — otherwise `main` and what's actually live silently disagree until someone remembers to reconcile them.

### Checking something against production from the shell

`.env.local` always points at the local Docker Supabase stack and is the only file `npm run dev`/`npm run build` ever load — that never changes. For a one-off check against the hosted production project (did that migration actually land, does this row look right, is a specific credential decryptable), there's a second, gitignored file, `.env.production.local`, loaded only on request into the current shell:

```bash
source scripts/env.sh production   # loads .env.production.local into this shell
source scripts/env.sh local        # back to .env.local's values
```

It must be **sourced**, not run as a script — a subprocess can't change its parent shell's environment. Populate `.env.production.local` yourself; it isn't generated automatically:

- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`: from the Supabase dashboard → Project Settings → API (or `supabase projects api-keys --project-ref <ref>`).
- `SUPABASE_DB_URL`: the transaction-pooler connection string (Project Settings → Database → Connection string → "Transaction" mode) — the project's direct `db.<ref>.supabase.co:5432` host is IPv6-only and won't resolve from most machines/networks.
- `CREDENTIALS_ENCRYPTION_KEY`: the same value set as a Vercel Secret for the production deployment. Vercel never returns a Secret's plaintext once saved (not even to `vercel env pull`, which writes a `[SENSITIVE]` placeholder for it) — copy it from wherever it was first generated, or rotate it in the Vercel dashboard if that's genuinely lost (rotating invalidates every credential already encrypted with the old key, so only do this if you actually need to).

Never commit this file (already covered by the `.env.*.local` pattern in `.gitignore`), and never paste its values over `.env.local` — that would point local development at the production database.

## Author & License

Built by [Vasili Shlykoff](https://github.com/Shlykoff). Licensed under the [MIT License](LICENSE).
