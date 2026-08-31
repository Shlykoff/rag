// lib/channels/types.ts
//
// The generic adapter contract every channel under lib/channels/ (Telegram
// today, Slack/others later) implements. Deliberately provider-agnostic --
// nothing here mentions Telegram, so a future Slack adapter (or anything
// else) implements the exact same shape. (An earlier lib/channels/index.ts
// speculatively registered adapters by string key for a hypothetical
// future generic-dispatch caller that never materialized -- deleted as
// dead code; the one real caller,
// app/api/channels/telegram/[integrationId]/route.ts, imports
// lib/channels/telegram/adapter.ts directly, since Next.js's own URL
// routing is already channel-specific.)
//
// IMPORT BOUNDARY (CLAUDE.md non-negotiable rule 8): this file, and
// everything else under lib/channels/**, may import lib/gateway/answer.ts
// and generic Supabase client helpers (e.g. lib/supabase/service-client.ts)
// -- and NOTHING else from lib/chat/, lib/retrieval/, lib/ai/, or
// lib/rate-limit/ directly. This mirrors the existing lib/ai/ / lib/sources/
// "pluggable module behind a narrow interface" convention, applied one
// layer further out: lib/gateway/answer.ts is the one seam.

/**
 * One inbound message from an external channel, already normalized away
 * from that channel's own wire format (Telegram's `Update` JSON, a future
 * Slack event payload, ...).
 */
export interface IncomingChannelMessage {
  /** Which channel this came from, e.g. "telegram" -- matches ChannelAdapter.channel and channel_integrations.channel. */
  channel: string;
  /** Opaque per-channel participant id (e.g. a Telegram chat_id as text). */
  externalParticipantId: string;
  text: string;
  /** Whatever this channel's adapter needs to send a reply back to the right place (e.g. a Telegram chat_id) -- opaque to everything outside that adapter, round-tripped through sendReply(). */
  replyTarget: unknown;
}

/** One project's configuration for one channel -- the decrypted, in-memory shape a ChannelAdapter actually operates on (see lib/channels/telegram/integration-store.ts for how this is produced from the encrypted `channel_integrations` row). */
export interface ChannelIntegrationConfig {
  id: string;
  projectId: string;
  channel: string;
  /** Channel-specific decrypted credentials (e.g. { botToken, webhookSecret } for Telegram) -- opaque here, each adapter knows its own shape. */
  credentials: unknown;
}

/**
 * The contract every channel adapter implements. Two methods only, both
 * channel-specific wire-format concerns -- everything else (rate limiting,
 * retrieval, generation) happens on the other side of
 * lib/gateway/answer.ts, which adapters call directly, not through this
 * interface.
 */
export interface ChannelAdapter {
  readonly channel: string;
  /**
   * Parses one inbound HTTP request (a webhook delivery) into a generic
   * message, or reports why it isn't one:
   *   - "message": a real, actionable text message -- the caller should
   *     proceed to answer it.
   *   - "ignore": a well-formed, authenticated request that doesn't need a
   *     reply (a non-text update, an already-processed duplicate, a
   *     channel-level event with no user-facing text, ...). NOT an error.
   *   - "unauthorized": failed this channel's own request-authenticity
   *     check (e.g. a missing/wrong Telegram webhook secret header) -- the
   *     caller must not act on this request's contents at all.
   */
  parseIncoming(
    request: Request,
    integration: ChannelIntegrationConfig
  ): Promise<
    | { kind: "message"; message: IncomingChannelMessage }
    | { kind: "ignore" }
    | { kind: "unauthorized" }
  >;
  /** Sends a reply back to wherever `message.replyTarget` points, using this integration's credentials. */
  sendReply(message: { replyTarget: unknown; text: string }, integration: ChannelIntegrationConfig): Promise<void>;
}
