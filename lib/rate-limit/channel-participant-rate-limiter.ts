// lib/rate-limit/channel-participant-rate-limiter.ts
//
// "Layer 2" of the gateway's three-layer concurrency model (see
// lib/gateway/answer.ts's module comment for the full picture): a
// per-EXTERNAL-PARTICIPANT request-rate limit, so one abusive/misbehaving
// Telegram (etc) user can't starve the rest of a project's audience out of
// "layer 1"'s shared per-project budget (lib/rate-limit/rate-limiter.ts).
// Tighter than layer 1's default on purpose -- a single legitimate human
// chatting with a bot sends messages at human typing speed, not in a tight
// loop.
//
// Mirrors lib/rate-limit/source-ingest-rate-limiter.ts's exact shape:
// synchronous, in-memory sliding window, no `await` anywhere in the check
// function (so there's no gap for a parallel burst to race through the
// way lib/rate-limit/rate-limiter.ts's DB-backed layer 1 needs an explicit
// reservation step to close -- see that module's own comment for why).
// Deliberately NOT backed by `usage_events`, for the same reason
// source-ingest-rate-limiter.ts gives for itself: this is an abuse
// backstop specific to one concern (don't let one participant flood a
// project), not a billing/cost-tracking signal -- usage_events already
// gets one row per real AI-provider call regardless of which layer let it
// through, so this doesn't need its own event type.
//
// Same documented limitation as every other in-memory limiter in this
// project (see README "Rate limiting"): per-Node-process state, not shared
// across multiple warm serverless instances. Accepted MVP tradeoff, not a
// silent gap.

import "server-only";

export interface ChannelParticipantRateLimitConfig {
  /** Max messages allowed within windowMs, per (project, channel, externalParticipantId). */
  maxRequests: number;
  windowMs: number;
}

/**
 * Tighter than layer 1's chat default (10 requests/60s, shared across an
 * entire project's audience) -- 5 requests/60s is generous for a real
 * human typing questions to a bot one at a time, while still capping how
 * much of the shared project budget one participant can burn through on
 * their own before layer 1 (or this layer) starts rejecting them.
 */
export const DEFAULT_CHANNEL_PARTICIPANT_RATE_LIMIT: ChannelParticipantRateLimitConfig = {
  maxRequests: 5,
  windowMs: 60_000, // 1 minute
};

export interface ChannelParticipantRateLimitResult {
  allowed: boolean;
  /** How many messages this participant has sent in the current window, INCLUDING this one when allowed. */
  currentCount: number;
  limit: number;
  /** Milliseconds until the oldest request in the window ages out -- a reasonable "try again in" hint. Only meaningful when allowed === false. */
  retryAfterMs: number;
}

const requestTimestamps = new Map<string, number[]>();

/** Same composite-key shape as lib/rate-limit/conversation-lock.ts ("layer 3") -- both layers key off exactly the same (project, channel, participant) triple, deliberately kept as one shared helper so the two layers can never silently drift apart on how they derive a key from the same inputs. */
export function channelParticipantKey(projectId: string, channel: string, externalParticipantId: string): string {
  return `${projectId}:${channel}:${externalParticipantId}`;
}

/** Test-only escape hatch: requestTimestamps is module-level state that would otherwise leak between test cases run in the same process. Not meant to be reached for outside lib/rate-limit/__tests__. */
export function __resetChannelParticipantRateLimitForTests(): void {
  requestTimestamps.clear();
}

/**
 * Checks AND records one message attempt for (projectId, channel,
 * externalParticipantId), atomically -- same "no `await` anywhere, so no
 * burst gap to close" reasoning as
 * lib/rate-limit/source-ingest-rate-limiter.ts's checkSourceIngestRateLimit.
 *
 * Call this from lib/gateway/answer.ts, AFTER resolving the project/owner
 * but BEFORE acquiring the conversation lock (layer 3) or reserving a
 * layer-1 slot -- rejecting a spamming participant here is cheaper than
 * letting them contend for the lock or eat into the shared project budget
 * first.
 */
export function checkChannelParticipantRateLimit(
  projectId: string,
  channel: string,
  externalParticipantId: string,
  config: ChannelParticipantRateLimitConfig = DEFAULT_CHANNEL_PARTICIPANT_RATE_LIMIT
): ChannelParticipantRateLimitResult {
  const key = channelParticipantKey(projectId, channel, externalParticipantId);
  const now = Date.now();
  const cutoff = now - config.windowMs;
  const existing = requestTimestamps.get(key) ?? [];
  const fresh = existing.filter((ts) => ts > cutoff);

  if (fresh.length >= config.maxRequests) {
    // Still write back the purged (but not incremented) list -- keeps the
    // map from accumulating stale entries for a participant who keeps
    // getting rejected without ever succeeding.
    if (fresh.length > 0) requestTimestamps.set(key, fresh);
    else requestTimestamps.delete(key);
    const oldest = fresh[0];
    return {
      allowed: false,
      currentCount: fresh.length,
      limit: config.maxRequests,
      retryAfterMs: Math.max(0, oldest + config.windowMs - now),
    };
  }

  fresh.push(now);
  requestTimestamps.set(key, fresh);
  return { allowed: true, currentCount: fresh.length, limit: config.maxRequests, retryAfterMs: 0 };
}
