// lib/channels/index.ts
//
// Small registry of channel adapters by name, mirroring lib/ai/index.ts's
// PROVIDER_REGISTRY shape (a Record keyed by a short string id). Adding a
// new channel (Slack, ...) means: write its adapter(s) under
// lib/channels/<name>/, add one entry here -- nothing else in this file
// needs a matching edit.
//
// Note: app/api/channels/telegram/[integrationId]/route.ts does NOT go
// through this registry -- Next.js's own URL routing is already
// channel-specific (the path segment is literally "telegram"), so that
// route imports lib/channels/telegram/adapter.ts's
// handleTelegramWebhook() directly. This registry exists for any FUTURE
// caller that needs to look an adapter up generically by a channel string
// rather than knowing which one at compile time (e.g. a shared admin tool
// that inspects channel_integrations rows across channel types).

import type { ChannelAdapter } from "./types";
import { telegramChannelAdapter } from "./telegram/adapter";

export const CHANNEL_REGISTRY: Record<string, ChannelAdapter> = {
  telegram: telegramChannelAdapter,
};

export function getChannelAdapter(channel: string): ChannelAdapter | undefined {
  return CHANNEL_REGISTRY[channel];
}

export type { ChannelAdapter, ChannelIntegrationConfig, IncomingChannelMessage } from "./types";
