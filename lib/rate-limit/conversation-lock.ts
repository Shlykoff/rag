// lib/rate-limit/conversation-lock.ts
//
// "Layer 3" of the gateway's three-layer concurrency model (see
// lib/gateway/answer.ts's module comment): mutual exclusion (not a
// counting window, unlike layers 1/2) per (project, channel,
// externalParticipantId) -- at most one in-flight RAG turn per external
// participant at a time. Without this, a channel platform redelivering a
// webhook (retries, duplicate taps, double-sending) while the first
// delivery is still mid-flight would run handleChatRequest concurrently
// for the same conversation, doubling cost, racing on which reply lands
// last, and duplicating messages/usage_events rows for what the
// participant experiences as one message.
//
// Reject, don't queue, an overlapping message from an already-locked
// participant (lib/gateway/answer.ts returns
// GatewayAnswerResult{kind:"rate_limited"} rather than waiting for the
// lock): this project has no queue infrastructure. The channel adapter
// (lib/channels/telegram/adapter.ts) simply doesn't reply to the rejected
// duplicate -- their first message is still being answered.
//
// Same composite key shape as
// lib/rate-limit/channel-participant-rate-limiter.ts ("layer 2") --
// channelParticipantKey() is imported from there rather than reimplemented,
// so the two layers can never derive a key from the same inputs differently.
//
// Known, accepted MVP limitation: this is a plain in-memory `Set`, scoped
// to one Node process/instance -- unlike layer 1, which is partly DB-backed
// via usage_events. On a multi-instance deployment, two overlapping webhook
// deliveries for the same participant could land on different instances
// and both acquire "the" lock (each instance only knows its own in-memory
// Set) -- the worst case is a rare duplicate/interleaved reply to that one
// participant, not a security hole or cross-participant leak. Airtight
// serialization across instances would need a DB-backed claim (e.g.
// `pg_advisory_lock`); out of scope for this stage -- see README "Rate
// limiting" for the same caveat.

import "server-only";
import { channelParticipantKey } from "./channel-participant-rate-limiter";

const lockedKeys = new Set<string>();

/** Test-only escape hatch: lockedKeys is module-level state that would otherwise leak between test cases run in the same process. Not meant to be reached for outside lib/rate-limit/__tests__. */
export function __resetConversationLocksForTests(): void {
  lockedKeys.clear();
}

/**
 * Attempts to acquire the lock for (projectId, channel,
 * externalParticipantId). Returns `true` if this call acquired it (the
 * caller now owns the lock and MUST call releaseConversationLock() with
 * the exact same arguments once done, in a `finally`, whether the turn
 * succeeded or failed) -- or `false` if another in-flight turn for the
 * same participant already holds it (the caller must NOT proceed, and
 * must NOT call release -- it never acquired anything). Synchronous, no
 * `await`, so (within one process) two concurrent callers can never both
 * observe the lock as free and both acquire it -- same "no gap for a
 * parallel burst to race through" property every other in-memory limiter
 * in this project relies on.
 */
export function acquireConversationLock(projectId: string, channel: string, externalParticipantId: string): boolean {
  const key = channelParticipantKey(projectId, channel, externalParticipantId);
  if (lockedKeys.has(key)) return false;
  lockedKeys.add(key);
  return true;
}

/**
 * Releases a lock previously acquired by acquireConversationLock() for the
 * exact same (projectId, channel, externalParticipantId). Idempotent: safe
 * to call even if the lock isn't currently held (a no-op) -- callers that
 * always release in a `finally` don't need to track whether their own
 * acquire call actually succeeded first.
 */
export function releaseConversationLock(projectId: string, channel: string, externalParticipantId: string): void {
  lockedKeys.delete(channelParticipantKey(projectId, channel, externalParticipantId));
}
