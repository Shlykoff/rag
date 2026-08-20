# RAG Assistant

[![ko-fi](https://img.shields.io/badge/Ko--fi-F16061?style=for-the-badge&logo=ko-fi&logoColor=white)](https://ko-fi.com/shlykoff)

An AI assistant with retrieval-augmented generation (RAG) over your own documents — uploaded files, Notion pages, public URLs, and a Google Drive folder — with a provider-independent AI layer (OpenAI / Anthropic+Voyage / Gemini, switchable via one env var) and sources cited under every answer.

Full spec: [`docs/spec.md`](docs/spec.md). Architectural ground rules for every part of this project: [`CLAUDE.md`](CLAUDE.md).

## Status

This project is built incrementally by specialized agents (see `.claude/agents/`). Current state:

- [x] **Database schema** (`db-architect`): Postgres schema, `pgvector`, RLS policies, `match_document_chunks` RPC, migrations, seed data.
- [x] **RAG pipeline** (`rag-pipeline-specialist`): AI provider abstraction, chunking, embeddings, retrieval, streaming chat API, rate limiting. See "RAG pipeline" section below.
- [x] **Document sources** (`document-sources-specialist`, this README section): manual upload (PDF/markdown/txt), Notion, public URL (SSRF-protected), Google Drive folder sync, encrypted per-user credentials, `app/api/sources/*` endpoints. **This is what's documented below, under "Document sources".**
- [x] **Frontend** (`nextjs-frontend`): streaming chat UI (`useChat`-style SSE consumption via a hand-rolled parser, not the AI SDK's default UI-message protocol — see "Frontend" section below), a single "add a source" screen covering all four source types with inline instructions, per-document sync/processing status + manual Refresh, clickable sources under every assistant answer, conversation history, demo login. See "Frontend" below.

There is no live deploy or screenshots yet — deployment to Vercel is a later step, not blocked on the frontend existing. Run it locally per "Running locally" below in the meantime.

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

npm run dev               # http://localhost:3000
```

Open `http://localhost:3000/login` and click **"Попробовать демо"** to sign in as the seeded demo account (`demo@example.com` / `demo-password-123`, created by `supabase/seed.sql` — see the warning at the top of that file about this password being intentionally hardcoded/committed for **local dev only**; that demo-user block is deliberately skipped when pushing migrations to a hosted project, per CLAUDE.md's "Local environment: Supabase in Docker" section) with two pre-ingested documents already `ready` to ask questions against.

### Tests

```bash
npm test                  # fast unit tests, no Docker required (161 tests)
npm run test:integration  # requires `supabase start` first -- runs against
                           # the real local Postgres/pgvector (17 tests)
```

`npm test` never touches a database — everything is exercised against fakes (see e.g. `lib/ingestion/__tests__/ingest.test.ts`). `npm run test:integration` loads `.env.local` (via Node's `--env-file`) and runs a second suite of `*.integration.test.ts` files against your local `supabase start` instance: real inserts, a real `match_document_chunks` RPC call, real cross-tenant isolation checks. It's a separate Vitest config (`vitest.integration.config.mts`) specifically so plain `npm test`/CI never needs Docker running.

## Architecture: the AI provider abstraction (`lib/ai/`)

Business logic (retrieval, the chat API route, ingestion) never imports `openai`, `@ai-sdk/*`, or `voyageai` directly — only `lib/ai/index.ts`'s `getAIProviders()` factory, which returns a `{ chatProvider, embeddingsProvider }` pair selected by `AI_PROVIDER`:

| `AI_PROVIDER` | Chat | Embeddings | Notes |
|---|---|---|---|
| `openai` | `gpt-4.1-mini` via `@ai-sdk/openai` streaming | `text-embedding-3-small`, `dimensions: 1024` | default; cheapest to keep alive for a demo |
| `anthropic` | `claude-sonnet-4-5` via `@ai-sdk/anthropic` streaming | Voyage `voyage-3-large`, `outputDimension: 1024` | Anthropic has no embeddings API — Voyage is a fixed pairing, not independently configurable |
| `gemini` | `gemini-3.6-flash` | `gemini-embedding-001`, `dimensions: 1024` | reuses the **same underlying HTTP client** as `openai` (`createOpenAICompatiblePair()`, see `lib/ai/providers/openai.ts`), just pointed at Google's official OpenAI-compatible endpoint (`https://generativelanguage.googleapis.com/v1beta/openai/`) via a different `baseURL`/`apiKey`/`model` — see `lib/ai/providers/gemini.ts`. This is a deliberate reuse (Google guarantees wire-format compatibility for this subset of the API), not a copy-paste shortcut. |

All three are pinned to **1024-dimensional** vectors (`dimensions`/`outputDimension`), matching `document_chunks.embedding vector(1024)` — switching providers never requires a schema migration. 1024 (not the more common 1536) was chosen specifically because **Voyage AI does not support 1536 at all**: `voyage-3-large`/`voyage-4` only accept `output_dimension` from the fixed set `{256, 512, 1024, 2048}`, and since Anthropic has no embeddings API of its own, `AI_PROVIDER=anthropic` depends on Voyage. 1024 is Voyage's own default and the common denominator — OpenAI and Gemini can both shorten their native embedding output down to an arbitrary dimension (including 1024), so pinning everyone to 1024 is what makes all three providers usable behind one `vector(1024)` column. **Switching providers does always require a full re-ingest**: different embedding models produce incompatible vector spaces even at equal dimensionality. `document_chunks.embedding_provider`/`embedding_model` record which provider/model produced each row specifically so a provider switch's "which documents need re-embedding" question has a real SQL answer (`select distinct embedding_provider, embedding_model from document_chunks`), not "ask whoever remembers".

**One `PROVIDER_REGISTRY` is the single source of truth for "which `AI_PROVIDER` values exist"** (`lib/ai/index.ts`) — a `Record` keyed by provider name, each entry holding its default model names, its display label (for the "Работает на: ..." sidebar badge — `lib/ui/ai-provider.ts` imports the same registry rather than keeping its own copy), and a `build()` factory. `SupportedAIProvider`, the `AI_PROVIDER` validity check, and its error message ("Expected one of: ...") are all *derived* from the registry's keys, not hand-duplicated across three places the way an earlier version of this file did. Adding a fourth provider (Grok, Qwen, ...) means: write its adapter(s) in `lib/ai/providers/`, add one entry to `PROVIDER_REGISTRY` — nothing else in this file, and nothing in `lib/ui/ai-provider.ts`, needs a matching edit.

**A real, live-caught bug worth calling out**: `createOpenAICompatiblePair()`'s two-views-over-one-client shape (`lib/ai/providers/openai.ts`) exists specifically because an earlier version handed out *one* object as both `chatProvider` and `embeddingsProvider` — TypeScript's structural typing can't make a single `modelName` field mean "chat model" when read through one interface and "embedding model" through the other. That bug silently wrote the *chat* model name into `document_chunks.embedding_model` for every `openai`/`gemini`-ingested row (confirmed live: a real `AI_PROVIDER=gemini` ingest recorded `embedding_model = "gemini-3.6-flash"`, not `"gemini-embedding-001"` — the actual embed() call always used the right model, only the metadata describing it was wrong). Fixed by never sharing one dual-role object; see `lib/ai/__tests__/index.test.ts` for the regression test and that file's/`openai.ts`'s comments for the full story.

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

## Document sources (`lib/sources/`)

Four pluggable adapters behind one `DocumentSource`/`NormalizedDocument` contract (`lib/sources/types.ts`) — `{ title, text, sourceType, sourceRef }` — that every source normalizes down to before handing off to `lib/ingestion/ingest.ts`. None of the adapters chunk or embed anything themselves; `lib/sources/pipeline.ts` is the one place that writes to `documents`, uploads to the private `documents` Storage bucket, and calls the shared ingest pipeline, so that wiring can't drift between sources.

| Source | Adapter | Auth | Notes |
|---|---|---|---|
| Manual upload | `lib/sources/manual-upload.ts` | none | PDF/markdown/txt, 20MB cap. Original file bytes are what's stored in Storage (`storage_path` = `original.<ext>`) — there's no separate cached-text object, since re-chunking just re-extracts from the stored original. |
| Notion | `lib/sources/notion.ts` | Internal Integration Secret, encrypted per-user | Page or database by URL/id, via `@notionhq/client`. Nested blocks/sub-pages followed up to 3 levels deep, not indefinitely. |
| Public URL | `lib/sources/url.ts` + `lib/sources/net/safe-fetch.ts` | none | SSRF-guarded fetch (see below) + `@mozilla/readability`/`jsdom` main-content extraction. |
| Google Drive folder | `lib/sources/google-drive.ts` | Service Account JSON, encrypted per-user | One folder id, **no recursion into subfolders** (see "MVP boundaries" below), via `googleapis`. |

### API routes (`app/api/sources/`)

Thin HTTP adapters — auth (same `getAuthenticatedUser`/`getRouteHandlerSupabaseClient` pattern as `app/api/chat/route.ts`) → call the adapter → `lib/sources/pipeline.ts` (Storage + ingest) → JSON response. Errors are normalized through `lib/sources/errors.ts`'s `SourceError` (mirrors `lib/ai/errors.ts`'s `AIProviderError` pattern) and mapped to HTTP status codes by `lib/sources/http-error.ts` (401 unauthorized, 403 "not shared", 400 bad input/SSRF-blocked, 422 empty content, 502 unclassified upstream failure).

- `POST /api/sources/upload` — multipart `file` field.
- `POST /api/sources/credentials` `{ sourceType: "notion"|"google_drive", credential }` / `GET` — save (encrypted) or check connection status for Notion/Drive credentials. The plaintext is never echoed back, logged, or returned by `GET` (which only returns booleans).
- `POST /api/sources/notion` `{ pageUrl }`, `POST /api/sources/url` `{ url }`, `POST /api/sources/google-drive` `{ folderId }` — all three **upsert** by `(user_id, source_type, source_ref)` via `lib/sources/pipeline.ts`'s `upsertDocumentFromSource`, so re-submitting the same page/URL/folder updates the existing document instead of duplicating it.
- `POST /api/sources/{documentId}/refresh` — the manual "Refresh" button target for one existing (non-manual_upload) document: re-fetches from its recorded `source_ref` and re-runs ingest. `manual_upload` documents get `400` (nothing external to refresh).

### SSRF protection (`lib/sources/net/safe-fetch.ts`, `lib/sources/net/ip-guard.ts`)

The most security-critical code in the project — a user-supplied URL that the server fetches on their behalf is the textbook SSRF vector. Full reasoning lives in `safe-fetch.ts`'s module header (deliberately not condensed there per project convention); summary:

- **Scheme allowlist**: only `http`/`https` — `file://`, `ftp://`, `data:`, `gopher://`, etc. are rejected before any I/O.
- **IP-range check** (`ip-guard.ts`, built on Node's built-in `net.BlockList`): blocks `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (which includes the `169.254.169.254` cloud-metadata address), plus `0.0.0.0/8` and `100.64.0.0/10` as the same category of hardening, and the IPv6 equivalents (`::1`, `fe80::/10`, `fc00::/7`) including IPv4-mapped forms (`::ffff:127.0.0.1`, `::ffff:169.254.169.254`) and AWS's IPv6 metadata prefix (`fd00:ec2::/*`, covered by the `fc00::/7` unique-local block). Invalid/unparseable input is treated as blocked (fail closed).
- **Two distinct code paths, because Node treats them differently**: a URL whose host is *already a literal IP* (e.g. `http://169.254.169.254/...` or `http://[::1]/...`) is checked directly — Node's `http`/`net` internals skip the custom DNS `lookup` hook entirely for a literal-IP host (confirmed empirically while building this, not documented prominently — see `validateUrl()`'s comment), so relying on the DNS-lookup check alone would have let the single most obvious SSRF payload straight through. A *hostname* is resolved via a custom `lookup` function (`guardedLookup`) that validates every resolved address and **is itself what the actual socket connects to** — not a separate "check, then let the HTTP client re-resolve" step, which would reopen a DNS-rebinding bypass (a compromised/malicious resolver can legitimately answer one query with a public IP and the very next one with a private one).
  - **IPv6-literal gotcha (fixed, previously a real bug)**: WHATWG `URL` always wraps an IPv6 host in brackets (`new URL("http://[::1]/").hostname === "[::1]"`), but `node:net`'s `isIP()`/`isBlockedAddress()` don't recognize a bracketed string as an IP at all, and `dns.lookup()` can't parse one either. The literal-IP check used to silently no-op for every IPv6 URL, and the request would then fail downstream with a generic `ENOTFOUND` from `dns.lookup("[::1]", ...)` — which *looked* like it was being blocked, but for the wrong reason (a DNS-parse failure, not a deliberate classification), and broke every public IPv6 URL identically. `stripIpv6Brackets()` (`ip-guard.ts`) strips the brackets before any `isIP`/`isBlockedAddress`/`dns.lookup`/socket-connect call, so IPv6 literals are now correctly classified (private ones blocked with `kind: "ssrf_blocked"`, public ones allowed through) instead of accidentally failing closed by coincidence.
- **Every redirect hop is followed manually and re-validated from scratch** (never handed to automatic redirect-follow) — the classic gap where a guard checks the URL the user typed, then lets the HTTP client silently follow a `302` into a private address without ever re-checking anything.
- **Timeout** (10s default, per hop) and **response-size cap** (10MB default), enforced by destroying the socket mid-stream the instant the cap is exceeded.

Tested in `lib/sources/net/__tests__/`:
- `ip-guard.test.ts` — pure, no-I/O tests of every required range (boundaries included: `172.15.255.255`/`172.32.0.0` just outside `172.16.0.0/12`, etc.), the IPv6/IPv4-mapped cases, and fail-closed-on-invalid-input.
- `safe-fetch.test.ts` — end-to-end against the **real, unmocked** guard: scheme rejection, and literal blocked-IP URLs (`127.0.0.1`, `169.254.169.254`, `10.x`, `192.168.x` over both http/https) rejected with no network reached (DNS-lookup on an IP literal is local, so these run fast with no internet access needed). Also covers the IPv6-bracket fix specifically, end-to-end through `safeFetch()`/`validateUrl()` (not just the pure `isBlockedAddress()` unit tests, which never see a bracketed hostname since the bug was in how `validateUrl()` fed it that string): `http://[::1]/`, `http://[fe80::1]/`, `http://[::ffff:169.254.169.254]/`, and `http://[fd00:ec2::254]/` are all rejected with `kind: "ssrf_blocked"` specifically (asserted via `SourceError.message`/the underlying `EBLOCKEDADDRESS`-vs-`ENOTFOUND` distinction, not just "the promise rejected") — proving the block is a real classification, not an incidental DNS-parse failure. A companion test confirms `stripIpv6Brackets` + `isIP`/`isBlockedAddress` correctly let a **public** IPv6 literal (`2001:4860:4860::8888`) past `validateUrl()`.
- `safe-fetch-redirects.test.ts` — the redirect-hop-revalidation *mechanism* specifically, against two real local HTTP servers with a mocked `ip-guard` (allow hop 1, block hop 2) — see that file's header for exactly why a mock is needed here (there's no way to make a real "looks public, resolves private" hostname work without either real internet access or a loopback address the real classifier would, correctly, always block too). Also covers `maxRedirects` enforcement, `maxBytes` mid-stream abort, and per-hop timeout.

### Credential encryption (`lib/sources/crypto.ts`, `lib/sources/credentials.ts`)

Notion Internal Integration Secrets and Google Service Account JSON keys are encrypted **at the application layer** (AES-256-GCM, Node's built-in `crypto`) before ever being written to `source_credentials` — not Supabase Vault (see that migration's header comment for the local-vs-hosted KMS-key-inconsistency rationale). The key lives only in `CREDENTIALS_ENCRYPTION_KEY` (`.env.local`/Vercel env var, never in the DB, never in the client bundle) — generate one with `openssl rand -hex 32`. Being an AEAD cipher, a tampered/corrupted ciphertext fails to decrypt loudly instead of silently returning garbage. `lib/sources/crypto.ts` carries `import "server-only"` like every other module in this package that touches a secret, so an accidental client-bundle import fails the build loudly instead of shipping decryption logic (and, transitively, the ability to derive plaintext credentials) to the browser. Round-tripped against a real Postgres `bytea` column (verifying the assumed `\x`-hex wire encoding actually holds, not just an assumption both sides of a mock happen to agree on) in `lib/sources/__tests__/credentials.integration.test.ts`; the pure encrypt/decrypt logic (including tamper/wrong-key/bad-key-length failure modes) is unit-tested in `lib/sources/__tests__/crypto.test.ts`.

**Also secret, in a different way: live OAuth tokens must never land in application logs either.** `googleapis`/`gaxios` errors carry the full outgoing Drive API request — including the service account's `Authorization: Bearer <access-token>` header, set by `google-auth-library` — as `err.config`/`err.response.config`. `SourceError.cause` wraps that raw error for every Drive API failure (see `lib/sources/google-drive.ts`'s `translateDriveError`), so logging a caught error object (or its `.cause`) directly would put a live token in the logs the moment anything inspects deeper than Node's default `util.inspect` depth. `safeErrorForLog()` (`lib/sources/errors.ts`) is the one function allowed to pull loggable fields (`name`/`message`/`status`/`kind`) off an arbitrary caught error, and every `console.error` in `lib/sources/google-drive.ts` and `app/api/sources/google-drive/route.ts` that logs a caught error routes through it — never the raw object. Verified in `lib/sources/__tests__/errors.test.ts` with a fake `GaxiosError`-shaped object carrying a planted token: asserts the token/`Authorization`/`Bearer` never appear anywhere in the logged output, not just "the token happens not to show up this time".

### "Not shared" errors (Notion / Google Drive)

The single most common real-world failure for both sources is the user forgetting to actually share the page/folder with the integration/service account. Both return a bare, ambiguous error from their APIs in this case (Notion: `404`, deliberately indistinguishable from "doesn't exist", so a token can't be used to probe for pages it can't see; Google Drive: `403`/`404`, and an empty folder listing is indistinguishable from an unshared one) — `notion.ts`/`google-drive.ts` translate these into an explicit, actionable Russian message telling the user exactly which button to click in Notion/Google Drive, rather than surfacing the raw status code.

### Manual re-sync only (no polling/webhooks)

Every source except `manual_upload` supports re-sync via `POST /api/sources/{documentId}/refresh` (or, for Google Drive, re-running `POST /api/sources/google-drive` to pick up new/changed files across the whole folder) — but **only when a user explicitly triggers it**. There is no polling, no Notion/Google webhook subscription, no cron job. This is a deliberate MVP boundary (CLAUDE.md), not a missing feature — implementing push-based sync would mean standing up webhook endpoints, verifying signatures, and handling out-of-order/duplicate delivery, none of which is needed for a portfolio-scale demo.

### MVP boundaries (explicit, not silent gaps)

- **Google Drive: one folder, no recursion into subfolders.** A subfolder encountered while listing is reported back as `skipped` with an explanatory reason, never descended into. Multi-level Drive folder trees need a follow-up task, not a code change to this adapter's contract.
- **Google Drive: you must share a *folder*, not an individual file.** `POST /api/sources/google-drive` only takes a `folderId` and lists `'<folderId>' in parents` — there is no "import this one file" entry point in the UI/API for a first-time import. This isn't just a missing feature; it's also a real Google Drive API gotcha worth knowing: sharing a single file directly with a service account (Share → add the service account's email) makes that file visible to `drive.files.list()`, but its **parent folder is not** — the returned file object has no `parents` field at all, so there is no folder id to pass even if you wanted to construct one. **Confirmed live**: sharing one Google Doc directly left it undiscoverable through the folder-sync endpoint; sharing its containing folder (with a PDF alongside it) worked immediately through `POST /api/sources/google-drive` — full pipeline, 36 chunks out of a ~750KB PDF, real retrieval + cited chat answer. Always share the folder your source lives in, never just the file.
- **Notion: nested blocks/sub-pages followed up to 3 levels deep**, not indefinitely — a workspace can have very deep or effectively-circular-feeling page-linking structures, and importing one page should not risk pulling in a large fraction of the workspace. A database import is capped at 200 rows and only queries its **first** data source (Notion's newer multi-data-source-database feature isn't fully supported).
- **URL extraction is UTF-8-only.** Pages served in a legacy encoding (windows-1251, ISO-8859-1, ...) without actually being UTF-8 will extract with mojibake. Same limitation applies to Google-Drive-downloaded `.txt`/`.md` files.
- **Manual upload's 20MB limit is an application-level ceiling**, not a guarantee — Vercel's own Serverless Function request-body limit (historically ~4.5MB on the Node.js runtime) may reject a large upload before it reaches this check at all when deployed there. A production fix would be a direct-to-Storage upload flow from the client, not raising the constant (see `lib/sources/manual-upload.ts`'s comment).
- **`/api/sources/*` rate limiting is per-instance, in-memory** (`lib/rate-limit/source-ingest-rate-limiter.ts`, 20 requests/minute/user by default) — same honest multi-instance caveat as the chat limiter (see "Rate limiting & cost control" below): a deployment with several warm serverless instances doesn't share counts across them.

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

Streaming uses the Vercel AI SDK's `streamText` internally (via each `ChatProvider` adapter), but the HTTP-level framing to the client is this project's own small SSE envelope (not the AI SDK's default UI-message protocol) specifically so it can carry the `sources`/`conversation` events alongside text — a custom, versioned, and fully documented contract the frontend can consume with a plain `fetch` + `ReadableStream` reader (or any SSE parser), independent of which `@ai-sdk/react` version ends up in use later. This is exactly what `components/chat/ChatView.tsx` does — see "Frontend" below.

## Frontend (`app/`, `components/`)

- **`app/(app)/`** — every protected page (new-chat `/`, `chat/[conversationId]`, `sources`), gated by `app/(app)/layout.tsx` (server-side `getAuthenticatedUser()` redirect to `/login`, belt-and-suspenders alongside `proxy.ts` below) which also fetches the conversation list once and passes it into `components/layout/Sidebar.tsx`. Each data-loading page has its own `loading.tsx` skeleton and relies on `app/(app)/error.tsx` for the error boundary.
- **`app/login/`** — `LoginForm.tsx` (`"use client"`): a one-click **"Попробовать демо"** button pre-filled with the seeded demo credentials (see "Running locally" above) plus a collapsible manual email/password form, both going through `lib/supabase/browser-client.ts`'s `signInWithPassword`.
- **`proxy.ts`** (Next.js 16's current name for what used to be `middleware.ts` — see the file's own header comment) — refreshes the Supabase session cookie on every request and redirects unauthenticated visitors to `/login` (excluding `app/api/**`, which does its own `401` JSON handling).
- **`components/chat/`** — `ChatView.tsx` is the client-side chat surface: posts to `/api/chat`, reads the response body as a stream via `parse-sse.ts` (a small hand-rolled SSE parser matching `app/api/chat/route.ts`'s exact envelope above, not `@ai-sdk/react`'s `useChat`, since the wire format here isn't the AI SDK's default UI-message protocol), and renders each `delta` event as it arrives — the answer visibly grows token-by-token, never appears only once the full response is done. `MessageBubble.tsx` renders one message plus, for assistant messages, `SourceList.tsx` underneath it.
- **`components/sources/`** — `AddSourceForm.tsx` is the single screen for all four source types (a tab/segmented picker, not four separate pages), delegating to `UploadForm.tsx` (client-side type/size validation before ever hitting `/api/sources/upload`, which re-validates server-side regardless), `NotionForm.tsx`/`GoogleDriveForm.tsx` (credential field + inline step-by-step instructions — "create an integration in Notion → share the target page with it → paste the secret here" — directly in the form, not only in this README) and `UrlForm.tsx`. `DocumentList.tsx`/`DocumentCard.tsx` render each document's `processing_status` (`pending`/`processing`/`ready`/`error`, via `lib/ui/format.ts`'s `processingStatusLabel`), `formatRelativeTime(last_synced_at)` ("синхронизировано 5 минут назад") for every non-`manual_upload` source, and a **Refresh** button wired to `POST /api/sources/{documentId}/refresh`.
- **Citations** (`lib/ui/format.ts`'s `citationLabel`/`sourceLinkHref`) render each of a message's `sources` (from the `sources` SSE event, see the wire contract above) as its own clickable/labelled line under the answer — phrased per source type ("на основе документа «X»" / "из Notion-страницы «X»" / "со страницы по ссылке X" / "из файла Google Drive «X»"), not a bare file list off to the side, per CLAUDE.md's "источники под каждым ответом" requirement. `sourceLinkHref` builds a real deep link for `url`/`notion`/`google_drive` sources (opens the actual Notion page / Drive file / public URL, not just names it); `manual_upload` has no external location, so it renders as plain (still clearly labelled) text.
- **Active AI provider footer** (`lib/ui/ai-provider.ts`'s `getActiveAIProviderInfo()`, rendered in `Sidebar.tsx`'s footer as "Работает на: **OpenAI**") — reads `AI_PROVIDER` directly (never constructs a real provider client, so it can't throw or need an API key just to render a label) and never crashes on an unset/unrecognized value (renders "не настроен" instead).
- **Loading/empty/error states**: every data-loading page ships all three — `loading.tsx` skeletons for the initial fetch, an explicit empty state with a call to action (`ChatView`'s "У вас пока нет ни одного документа" + a link to `/sources` when `hasDocuments` is false; `Sidebar`'s "Пока нет ни одного диалога"; `DocumentList`'s own empty state), and error states that turn a `429` into "Слишком много запросов, попробуйте через N сек." (`ChatView`'s `rateLimitNotice`, reading the same `retryAfterMs` the chat API route returns) rather than a raw stack trace, plus a **Повторить** (retry) button on any retryable assistant-message error.
- **Accessibility/responsiveness**: every form field has an associated `<label>` (including visually-hidden ones, e.g. the chat textarea's), focus states are the browser defaults (never suppressed with `outline: none`), and the sidebar collapses into a hamburger-triggered drawer (`Sidebar.tsx`'s `mobileOpen` state) below the layout's mobile breakpoint rather than just not-breaking at narrow widths.

## Rate limiting & cost control (`lib/rate-limit/rate-limiter.ts`)

Backed by the existing append-only `usage_events` table (db-architect's design — an event log + `COUNT(*)` over a time window, not a shared counter column, so concurrent requests can't race on a lost update; see that migration's "Atomicity note"). **Not** Vercel KV/Upstash: the project already has a Postgres table purpose-built for this, with an index (`user_id, created_at desc`) sized exactly for this query — adding a second stateful dependency for the same job wasn't worth it here.

`checkChatRateLimit(supabase, userId, { maxRequests: 10, windowMs: 60_000 })` (defaults) counts the user's `chat_request` events in the trailing window. On its own this has a real gap: a request's `chat_request` `usage_events` row isn't written until *after* its full streamed response finishes (seconds later, see `lib/chat/handle-chat-request.ts`), so `N` requests fired in parallel would all query the same too-low `COUNT(*)` and all pass a check that's individually correct but collectively bypassable — the cheapest way to run up an AI provider bill, and a direct violation of CLAUDE.md's "checked server-side, before calling the AI provider" rule if left unfixed.

**Fix: `reserveChatRateLimitSlot(supabase, userId, config)`** — what `app/api/chat/route.ts` actually calls, not `checkChatRateLimit` directly. It runs the same DB count, then adds an **in-process reservation**: a per-user, in-memory timestamp list of requests that have passed the check and started processing but haven't (yet, or ever) written their own `usage_events` row. The combined count (`DB rows` + `active reservations`) is what's checked against `maxRequests`, and — critically — the reservation is written *synchronously*, in the same tick the DB count resolves, with no further `await` in between; JS's single-threaded event loop means no other concurrent call for the same user can interleave inside that span, so two callers can never both observe a stale count and both reserve past the limit. `reserveChatRateLimitSlot` returns a `release()` function that `app/api/chat/route.ts` calls once the SSE stream is fully done (success or failure), in a `finally` block, freeing the slot (on success the real `usage_events` row has already landed by then; on failure no row is ever written, so the reservation was the only thing counting that attempt).

Why not a DB-persisted "pending" row instead of in-memory state: `usage_events` is deliberately append-only (service_role has `SELECT`+`INSERT` only, no `UPDATE`/`DELETE` at all — see the table migration's grants), specifically so nothing can mutate/erase rate-limit history. Turning a reservation into a real row, or clearing a failed one, needs `UPDATE`/`DELETE` — a schema/grant change that's `db-architect`'s call, not something this module should route around unilaterally. The in-memory layer is the explicit MVP-scoped tradeoff instead:

- ✅ Fully closes the burst race **within one Node process/instance** — verified with a concurrency test (`lib/rate-limit/__tests__/rate-limiter.test.ts`, "counts N concurrent requests against each other... exactly maxRequests are allowed, not all of them" — 5 parallel calls against a limit of 3 correctly yield exactly 3 `allowed`, not 5) and confirmed by demonstrating the opposite: the *same* concurrency test run against the old `checkChatRateLimit` alone (no reservation) lets all 5 through, proving this isn't a test that would pass regardless.
- ⚠️ Does **not** protect against a burst spread across multiple serverless instances (e.g. Vercel scaling out multiple Node processes for the same deployment under load) — each instance has its own `activeReservations` map. In that scenario the DB-only check is still the backstop, so the limit degrades from "hard N/window" to "hard N/window per warm instance, roughly N/window in practice for a lightly-scaled demo" rather than being fully bypassable — but it is a known, real gap for production multi-instance deployment, not silently claimed to be solved. Closing it fully would mean either a DB-persisted pending-row scheme (needs the schema/grant change above) or a shared store (Upstash/Vercel KV) — worth revisiting if/when this deploys behind more than one warm instance.

Verified against fakes (`lib/rate-limit/__tests__/rate-limiter.test.ts`, including the burst/release/idempotent-release cases above) and against the real table (`lib/rate-limit/__tests__/rate-limiter.integration.test.ts` — `embedding_request` events and other users' events don't leak into the count).

### Rate limiting on `/api/sources/*` (`lib/rate-limit/source-ingest-rate-limiter.ts`)

Every `POST /api/sources/{upload,notion,url,google-drive}` and `POST /api/sources/{documentId}/refresh` call ends in a real, billed embeddings-provider call (`ingestDocumentWithDefaultProviders`) — CLAUDE.md rule 4 applies here exactly as it does to `/api/chat`, and previously nothing enforced it: only per-document chunk count was bounded, not how often a small document could be resubmitted. `checkSourceIngestRateLimit(userId, { maxRequests: 20, windowMs: 60_000 })` (defaults, looser than chat's 10/min since a legitimate "add a few sources" session can plausibly submit several small documents in quick succession) is called in every one of those five route handlers, immediately after auth and **before** touching the network/adapter/AI provider at all — a rejection returns `429 { error: "rate_limited", message, retryAfterMs }` with a `Retry-After` header, matching `/api/chat`'s response shape exactly.

**Deliberately NOT backed by `usage_events`** (unlike the chat limiter) — `usage_events.event_type` is a fixed Postgres enum (`'chat_request' | 'embedding_request'`, see the table migration) with no value for "source ingestion request", and reusing `'embedding_request'` as-is would be actively wrong, not just imprecise: `lib/chat/handle-chat-request.ts` already writes an `embedding_request` row for every chat message's *query* embedding, so counting source-ingestion attempts against that same bucket would mean a user's chat activity eats into their source-ingestion allowance and vice versa. Adding a dedicated enum value is a schema change — `document-sources-specialist` doesn't make that call unilaterally (`db-architect`'s territory per CLAUDE.md's division of responsibility) — so this is instead a small, self-contained in-memory sliding-window counter, with no DB dependency and no `await` in its hot path at all (the count *is* the state, so there's no "stale read between check and record" race to close the way `reserveChatRateLimitSlot` has to for chat's DB-backed count).

Same explicit tradeoff as the chat limiter: fully closes the burst race within one Node process (verified: `lib/rate-limit/__tests__/source-ingest-rate-limiter.test.ts`, 5 synchronous calls against a limit of 3 correctly yield exactly 3 `allowed`), but does **not** share counts across multiple warm serverless instances — a known, documented MVP gap, not a silent one. If/when this deploys behind more than one warm instance, closing it fully means either a DB-persisted scheme (needs the `usage_events` schema/grant change above, `db-architect`'s call) or a shared store (Upstash/Vercel KV).

Separately, `lib/retrieval/search.ts`'s context token budget (default 3000 estimated tokens) bounds how much retrieved content gets attached to a single request regardless of how many documents a user has, and the chat API's request body caps the question itself at 4000 characters (zod `.max(4000)`) independent of that context budget.

Token usage (input/output, separately) and which provider/model served each request are logged to `usage_events` for every successful chat completion, and (as a best-effort *estimate*, not billing-accurate — `EmbeddingsProvider.embed()` doesn't return usage) for every retrieval embedding call — enough to compare provider cost/performance and estimate demo running cost once real usage accumulates.

## `.env.example`

Placeholders for every provider this project supports, even ones not used by the default demo config: `AI_PROVIDER`, `OPENAI_API_KEY` (+ optional model overrides), `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `GEMINI_API_KEY`, plus `NOTION_API_KEY`/`GOOGLE_SERVICE_ACCOUNT_JSON` (local-dev fallbacks only — the real per-user flow is `POST /api/sources/credentials`, see "Document sources" above), `CREDENTIALS_ENCRYPTION_KEY` (generate with `openssl rand -hex 32`), and the three Supabase vars. See the file itself for per-var comments.

## What's been verified live vs. what hasn't

Real API keys for all three providers are now configured in local development. Current status per provider, checked directly against each real API (not fabricated error objects):

- ✅ **`gemini` — fully verified end-to-end, live.** Real embeddings (`gemini-embedding-001`) and real streaming chat (`gemini-3.6-flash`) both confirmed against the actual API: a real Google Drive folder sync (a ~750KB PDF book, 36 chunks) → real retrieval (correct chunks ranked top by cosine similarity) → a real streamed chat answer citing the right sources by number. This is the provider the local demo currently runs on (`AI_PROVIDER=gemini` in `.env.local`).
- ⚠️ **`openai` — embeddings/chat request shape confirmed correct, but blocked by account quota.** A real ingest attempt correctly reached OpenAI's embeddings endpoint with the right model (`text-embedding-3-small`) and failed with a real `429 insufficient_quota` — i.e. the code path and request shape are right, the account just needs billing enabled. `documents.processing_status` correctly flipped to `'error'` with a clear message rather than hanging (see the `embedding_model` bugfix below, which this same live test caught).
- ⚠️ **`anthropic`+Voyage — Voyage embeddings confirmed working live; Claude chat blocked by account balance.** A real document was successfully chunked and embedded via Voyage (`voyage-3-large`). The chat call correctly reached `api.anthropic.com` with the right model/request shape and failed with a real "credit balance too low" error — same situation as OpenAI, an account-funding issue, not a code issue.
- ✅ **Verified against a real, running Supabase/Postgres/pgvector instance** (`npm run test:integration`, 17 tests): the `match_document_chunks` RPC's cross-tenant isolation and similarity ordering (with deterministic fabricated vectors), the rate limiter against the real `usage_events` table, the ingestion pipeline's delete-before-insert re-sync behavior against real `documents`/`document_chunks` rows, the chunking+retrieval "question → source" quality examples above (with a toy keyword embedding standing in for a real model), and (from `document-sources-specialist`) manual-upload end-to-end against real Storage and encrypted-credential round-tripping against a real `bytea` column.
- ✅ **Verified with fast unit tests against fakes** (`npm test`, 161 tests): chunking edge cases, the AI-provider error normalizer, the retry/backoff logic (including the retry-before-first-token bug the tests caught), embedding batch bisection, the rate limiter's query logic, the retrieval context-assembly/token-budget logic, the full chat request pipeline (conversation creation/reuse, message persistence, provider-failure handling), the `chatProvider`/`embeddingsProvider` model-name separation (see the `PROVIDER_REGISTRY` section above), and (from `document-sources-specialist`) the SSRF guard (including the IPv6-bracket classification fix), credential encryption, and the source-ingest rate limiter.
- **To try it yourself**: enable billing on the OpenAI/Anthropic account (or just use `AI_PROVIDER=gemini`, already confirmed working), then use the app normally — no further code changes needed.

## Project boundaries (this agent's scope)

Per `CLAUDE.md`, this part of the project (`rag-pipeline-specialist`) does **not** build: document source adapters (`lib/sources/*` — Notion/URL/Drive/manual upload, SSRF protection, Storage upload; **since built, see "Document sources" above**), the frontend/UI, or database migrations. It also doesn't create Supabase Auth users/sessions for real end users — `getAuthenticatedUser()` expects a session that already exists (via whatever sign-in flow `nextjs-frontend` builds); for now it's been exercised in tests against users created directly via the Supabase admin API.

### Document sources: what's been verified live vs. what hasn't (`document-sources-specialist`)

- ✅ **Manual upload, fully, end-to-end, against a real local Supabase** (`lib/sources/__tests__/manual-upload.integration.test.ts`): real text extraction → real upload to the private `documents` Storage bucket → download-and-byte-compare round trip → the real chunk/embed/store pipeline (with a deterministic fake `EmbeddingsProvider`, no AI key needed) → `documents.processing_status = 'ready'`. This is the one source that needs no external API key at all, so it's the most thoroughly verified.
- ✅ **Google Drive, fully, end-to-end, against the real Google API and a real service account.** Folder sync (`POST /api/sources/google-drive`) correctly listed and imported a real ~750KB PDF alongside a Google Doc from a real shared folder — native Google Docs export, downloaded-PDF extraction, and per-file skip-with-reason (unsupported types, subfolders) all confirmed against real API responses, not fabricated ones. See "MVP boundaries" above for a real gotcha this surfaced: a service account can see a directly-shared single file but not that file's parent folder, so **only folder sharing works as a first-time-import path** — confirmed both ways (single-file share: undiscoverable; folder share: worked immediately).
- ✅ **SSRF protection, exhaustively, against the real classifier** (`lib/sources/net/__tests__/`) — see "SSRF protection" above for the exact scenarios covered. This is deliberately the most heavily tested part of the whole project, per CLAUDE.md's explicit instruction.
- ✅ **Credential encryption round-tripped against a real Postgres `bytea` column** (`lib/sources/__tests__/credentials.integration.test.ts`) and the pure AES-256-GCM logic unit-tested (`lib/sources/__tests__/crypto.test.ts`).
- ⚠️ **Not yet verified**: an actual Notion API call (`@notionhq/client` request/response shapes accepted by the real API, the page/database-id-guessing fallback in `importNotionDocument`, the "not shared" 404 translation). The adapter is written and type-checked against the SDK's real, installed TypeScript types (not guessed), and its request/response shapes match the SDK's documented contract, but it hasn't round-tripped against the live Notion API yet. **First thing to check once a page is shared**: create a Notion internal integration, share a test page with it, `POST /api/sources/credentials` the secret, then `POST /api/sources/notion` — see "How to test each source manually" below.

### How to test each source manually

- **Manual upload**: `POST /api/sources/upload` with a multipart `file` field (PDF/`.md`/`.txt`) from an authenticated session. Should return `201 { documentId, chunkCount, status: "ready" }`; check `documents.storage_path` points at a real object in the `documents` Storage bucket and `document_chunks` has rows for that `document_id`.
- **Notion**: create an integration at [notion.so/my-integrations](https://www.notion.so/my-integrations) → copy its Internal Integration Secret → `POST /api/sources/credentials` `{ "sourceType": "notion", "credential": "<secret>" }` → open a test page in Notion → `···`/`Share` → `Connections` → add the integration → `POST /api/sources/notion` `{ "pageUrl": "<the page URL>" }`. Should return a document with text matching the page's content. Test the "not shared" path too: try a page that was never shared with the integration and confirm the `403 not_shared` response's message actually tells you what to do.
- **Public URL**: `POST /api/sources/url` `{ "url": "https://example.com" }` against any real public page — should return extracted main-content text, not raw HTML with nav/footer noise. Then test the SSRF guard manually: `{ "url": "http://169.254.169.254/" }` should return `400 ssrf_blocked` immediately.
- **Google Drive**: create a service account in Google Cloud Console → download its JSON key → `POST /api/sources/credentials` `{ "sourceType": "google_drive", "credential": "<minified JSON>" }` → share a test Drive **folder** (not an individual file — see "MVP boundaries" above; a directly-shared single file's parent folder isn't visible to the service account at all, so there's no `folderId` to use) with the service account's `client_email` (Viewer) → `POST /api/sources/google-drive` `{ "folderId": "<folder id from the Drive URL>" }`. Should return `{ imported: [...], skipped: [...] }` — put one PDF, one `.txt`, one Google Doc, and one unsupported file (e.g. a `.png`) in the folder to exercise all three code paths (native extraction, downloaded-file extraction, skip-with-reason) in one call.
- **Refresh**: after any of the above, `POST /api/sources/{documentId}/refresh` and confirm `documents.last_synced_at` advances and `document_chunks` reflects the re-fetched content (edit the source first to see the change actually propagate).
