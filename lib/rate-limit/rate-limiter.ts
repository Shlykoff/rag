// lib/rate-limit/rate-limiter.ts
//
// Per-PROJECT request rate limiting (projects architecture pivot -- this is
// "layer 1", the aggregate budget shared by a project's owner test chat
// AND every external channel session of that project, see
// lib/gateway/answer.ts), backed by the append-only `usage_events` table
// (db-architect's design -- see the migration's "Atomicity note": an event
// log + COUNT(*) range query, not a counter column, so concurrent requests
// never race on a shared UPDATE). Checked server-side, BEFORE calling the
// AI provider, per CLAUDE.md rule 4.
//
// This is deliberately NOT Vercel KV/Upstash: the project already has a
// Postgres table purpose-built for this by db-architect, with an index
// (project_id, created_at desc) sized exactly for "count this project's
// rows in the last N minutes". Adding a second stateful dependency
// (Upstash) for the same job would be complexity without benefit for a
// project already on Supabase Postgres. See README "Rate limiting" for
// this tradeoff written out for reviewers.
//
// KNOWN GAP closed by reserveChatRateLimitSlot() below (see its own
// comment for the full story, and README "Rate limiting" for the
// multi-instance caveat that fix does NOT close): `checkChatRateLimit`
// alone only counts usage_events rows that have already been written --
// but the chat_request row for a given request isn't written until AFTER
// its full response has finished streaming (see
// lib/chat/handle-chat-request.ts), which takes seconds. N requests fired
// in parallel within that window would all see the same (too-low) COUNT(*)
// and all pass, even though sequentially only the first would have. That's
// a real burst-bypass on the exact control CLAUDE.md requires ("Проверка
// лимита запросов ... на сервере, до вызова AI-провайдера").

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { purgeExpired } from "./sliding-window";

export interface RateLimitConfig {
  /** Max chat_request events allowed within `windowMs`. */
  maxRequests: number;
  windowMs: number;
}

export const DEFAULT_CHAT_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 10,
  windowMs: 60_000, // 1 minute
};

export interface RateLimitResult {
  allowed: boolean;
  /** How many chat_request events this project has in the current window (before this request). */
  currentCount: number;
  limit: number;
  /** Milliseconds until the oldest event in the window ages out, i.e. a reasonable "try again in" hint. Only meaningful when allowed === false. */
  retryAfterMs: number;
}

/**
 * Checks (without recording) whether `projectId` is currently under the
 * chat rate limit, by counting its `chat_request` usage_events rows in the
 * trailing `windowMs`. Call this BEFORE invoking the AI provider; the
 * actual usage_events row for *this* request is inserted separately, after
 * the call succeeds (see app/api/chat/route.ts) -- so a request that gets
 * rejected here never itself counts against the limit.
 *
 * Takes a SupabaseClient rather than constructing one itself so callers
 * decide which client to use (in production, the service-role client --
 * usage_events grants INSERT only to service_role, and even SELECT here
 * benefits from not being subject to a possibly-stale RLS session) and so
 * this function is unit-testable against a fake/mock client without
 * touching lib/supabase/service-client.ts's env-var requirements.
 */
export async function checkChatRateLimit(
  supabase: Pick<SupabaseClient, "from">,
  projectId: string,
  config: RateLimitConfig = DEFAULT_CHAT_RATE_LIMIT
): Promise<RateLimitResult> {
  const windowStart = new Date(Date.now() - config.windowMs).toISOString();

  const { data, error, count } = await supabase
    .from("usage_events")
    .select("created_at", { count: "exact" })
    .eq("project_id", projectId)
    .eq("event_type", "chat_request")
    .gte("created_at", windowStart)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`checkChatRateLimit: failed to query usage_events: ${error.message}`);
  }

  const currentCount = count ?? data?.length ?? 0;
  const allowed = currentCount < config.maxRequests;

  let retryAfterMs = 0;
  if (!allowed && data && data.length > 0) {
    const oldest = new Date(data[0].created_at as string).getTime();
    retryAfterMs = Math.max(0, oldest + config.windowMs - Date.now());
  }

  return { allowed, currentCount, limit: config.maxRequests, retryAfterMs };
}

// --- Burst-bypass fix: in-process reservation layer -----------------------
//
// Module-level (per Node process/instance) map of projectId -> reservation
// timestamps (ms). A "reservation" represents one request that has passed
// the rate limit check and started processing, but has not yet (and may
// never) written its own usage_events row. It's counted alongside the real
// DB rows in reserveChatRateLimitSlot() below, and removed again once the
// caller is done with the request (see ReservedChatRateLimitSlot.release).
//
// Why in-memory instead of a DB-persisted "pending" row: usage_events is
// intentionally append-only (service_role has SELECT+INSERT only, no
// UPDATE/DELETE at all -- see the table migration's grants) specifically so
// nothing can ever mutate/erase rate-limit history. Turning a reservation
// into a real row (or clearing a failed one) would need UPDATE/DELETE, i.e.
// a schema/grant change -- that's db-architect's call to make, not this
// module's to route around silently. This in-memory layer is the
// MVP-scoped fix called out as acceptable in the review: it fully closes
// the race *within one Node process*, and does NOT protect against a burst
// spread across multiple serverless instances (see README "Rate limiting"
// for that explicit, written-down limitation).
const activeReservations = new Map<string, number[]>();

/**
 * Drops this project's reservation timestamps older than windowMs, and
 * returns what's left (so callers get the post-purge list without a second
 * map lookup). Delegates the actual filter-and-write-back-or-delete logic
 * to lib/rate-limit/sliding-window.ts's shared purgeExpired() -- the one
 * piece of this reservation layer that genuinely IS the same "sliding
 * window" filtering step every other in-memory limiter in this project
 * needs; see that module's own header for why the REST of this layer
 * (reserve-now, release-later-by-value) doesn't fit
 * createSlidingWindowLimiter's record-immediately contract and stays
 * hand-rolled here.
 */
function purgeExpiredReservations(projectId: string, windowMs: number): number[] {
  return purgeExpired(activeReservations, projectId, windowMs);
}

/** Test-only escape hatch: activeReservations is module-level state that would otherwise leak between test cases run in the same file/process. Not exported from the package's public surface on purpose -- only lib/rate-limit/__tests__ reaches for this. */
export function __resetRateLimitReservationsForTests(): void {
  activeReservations.clear();
}

export type ReservedChatRateLimitSlot =
  | {
      allowed: true;
      currentCount: number;
      limit: number;
      /**
       * Must be called exactly once when this request is fully done being
       * processed (success -- its real usage_events row has already been
       * written by then, see lib/chat/handle-chat-request.ts -- or failure,
       * where no row is ever written and the reservation was the only
       * thing counting this attempt). Idempotent: safe to call more than
       * once (e.g. from both a success path and a `finally`). Forgetting
       * to call it leaks a reservation for up to `windowMs`, after which
       * purgeExpiredReservations() ages it out on its own -- so a bug here
       * degrades to "briefly stricter than the real limit", never to a
       * permanent lockout.
       */
      release: () => void;
    }
  | {
      allowed: false;
      currentCount: number;
      limit: number;
      retryAfterMs: number;
    };

/**
 * checkChatRateLimit() plus an in-process reservation, closing the
 * parallel-burst gap described in the module comment above. Call this
 * (not checkChatRateLimit) from the HTTP layer (app/api/chat/route.ts)
 * before starting to process a chat request; call `.release()` on the
 * result once the request is fully done (see that field's own comment).
 *
 * Atomicity: the DB count is read with one `await` (inside
 * checkChatRateLimit); everything from that await resolving through the
 * `activeReservations.set(...)` reservation below runs synchronously (no
 * further `await` in between). Node's single-threaded event loop means no
 * other call to this function for the same project can interleave inside that
 * synchronous span, so two concurrent callers can never both observe the
 * same combined count and both reserve a slot for a count that's already
 * at the limit -- this is what "atomic" means here, not a DB-level lock.
 */
export async function reserveChatRateLimitSlot(
  supabase: Pick<SupabaseClient, "from">,
  projectId: string,
  config: RateLimitConfig = DEFAULT_CHAT_RATE_LIMIT
): Promise<ReservedChatRateLimitSlot> {
  const dbResult = await checkChatRateLimit(supabase, projectId, config);

  // Everything below this line is synchronous -- see the atomicity note above.
  const reserved = purgeExpiredReservations(projectId, config.windowMs);
  const currentCount = dbResult.currentCount + reserved.length;
  const allowed = currentCount < config.maxRequests;

  if (!allowed) {
    return {
      allowed: false,
      currentCount,
      limit: config.maxRequests,
      // dbResult.retryAfterMs is only meaningful when the DB count alone
      // was already at/over the limit; when it's the in-memory reservations
      // that pushed us over, fall back to the full window -- reservations
      // are short-lived (one request's processing time), so "try again in
      // up to windowMs" is a safe, if conservative, hint.
      retryAfterMs: dbResult.retryAfterMs > 0 ? dbResult.retryAfterMs : config.windowMs,
    };
  }

  const stamp = Date.now();
  const arr = activeReservations.get(projectId) ?? [];
  arr.push(stamp);
  activeReservations.set(projectId, arr);

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    const cur = activeReservations.get(projectId);
    if (!cur) return;
    const idx = cur.indexOf(stamp);
    if (idx !== -1) cur.splice(idx, 1);
    if (cur.length === 0) activeReservations.delete(projectId);
  };

  return { allowed: true, currentCount, limit: config.maxRequests, release };
}
