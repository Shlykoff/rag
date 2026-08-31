// lib/channels/telegram/adapter.ts
//
// Implements the generic ChannelAdapter contract (lib/channels/types.ts)
// for Telegram, PLUS `handleTelegramWebhook()` -- the concrete,
// Telegram-specific orchestration app/api/channels/telegram/[integrationId]/route.ts
// actually calls directly (Next.js routing is already channel-specific per
// the URL path, so the route has no need for -- and this project has no --
// a generic-dispatch-by-channel-name registry; see lib/channels/types.ts's
// header for why an earlier speculative one was deleted as dead code).
//
// IMPORT BOUNDARY (CLAUDE.md rule 8): the only import from the core RAG
// stack anywhere in this file is `answerExternalMessage` from
// lib/gateway/answer.ts. Everything else is either local to
// lib/channels/telegram/**, generic (node:crypto), or a generic Supabase
// client helper (lib/supabase/service-client.ts) -- never lib/chat/,
// lib/retrieval/, lib/ai/, or lib/rate-limit/ directly.

import "server-only";
import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceRoleClient } from "../../supabase/service-client";
import { answerExternalMessage, type GatewayAnswerResult } from "../../gateway/answer";
import type { ChannelAdapter, ChannelIntegrationConfig, IncomingChannelMessage } from "../types";
import type { TelegramCredentials } from "./integration-store";
import { sendTelegramMessage } from "./client";

// Minimal, loosely-typed shape of the two Telegram update fields this
// adapter actually reads -- deliberately not a full Telegram Bot API
// typing (this project has no SDK dependency for Telegram, per this
// module's own design goal, see client.ts's header). Every other update
// field (edited_message, my_chat_member, channel_post, photo, sticker,
// ...) is left untyped and simply never inspected -- see parseIncoming's
// "gate non-text updates to ignore" logic below, which only ever looks at
// `update.message`.
interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number | string };
    text?: string;
  };
}

const START_MESSAGE =
  "Привет! Я бот-ассистент этого проекта — отвечаю на вопросы по подключённым к нему документам. Просто напишите вопрос. Команда /new начинает диалог заново.";
const NEW_CHAT_MESSAGE = "Начинаем новый диалог — предыдущая история переписки забыта.";

const RATE_LIMITED_REPLY = "Сейчас слишком много запросов, попробуйте, пожалуйста, через несколько секунд.";
const NO_CREDENTIALS_REPLY = "Этот бот ещё не настроен — обратитесь к владельцу проекта.";
const GENERIC_ERROR_REPLY = "Не получилось обработать сообщение. Попробуйте, пожалуйста, ещё раз чуть позже.";

/**
 * Verifies the `X-Telegram-Bot-Api-Secret-Token` header (Telegram echoes
 * back whatever `secret_token` was registered via setWebhook -- see
 * client.ts's setTelegramWebhook / scripts/telegram-set-webhook.ts) using
 * `crypto.timingSafeEqual`, NOT `===` -- a plain string comparison leaks
 * timing information proportional to how many leading characters match,
 * which is exactly the kind of side channel a webhook secret needs to be
 * defended against (this is this integration's entire trust boundary --
 * RLS does not apply to a request with no Supabase session at all, see
 * the channel_integrations migration's own comment on this).
 */
function verifySecretToken(request: Request, expectedSecret: string): boolean {
  const provided = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!provided) return false;
  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(expectedSecret, "utf8");
  // timingSafeEqual throws on a length mismatch rather than returning
  // false -- guard it explicitly. A length mismatch is not itself secret
  // (secrets here are fixed-length, generator-controlled), so this early
  // return doesn't reopen the timing side channel it exists to close.
  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Claims `updateId` for `integrationId` via `insert ... on conflict do
 * nothing` (channel_processed_updates' composite primary key is what makes
 * this race-safe against a truly concurrent duplicate delivery -- see that
 * table's migration). Returns `true` only if THIS call is the one that
 * inserted the row (i.e. this is the first time this update_id has been
 * seen for this integration) -- `false` for every other outcome (already
 * claimed, or the claim attempt itself failed), both of which mean the
 * caller must NOT process this update.
 */
async function claimUpdate(supabase: SupabaseClient, integrationId: string, updateId: number): Promise<boolean> {
  const { data, error } = await supabase
    .from("channel_processed_updates")
    .upsert(
      { integration_id: integrationId, update_id: updateId },
      { onConflict: "integration_id,update_id", ignoreDuplicates: true }
    )
    .select("integration_id");
  if (error) {
    // Fail closed: if the claim itself couldn't be recorded, don't process
    // the update -- processing without a durable claim risks a duplicate
    // reply on Telegram's next retry, which is a worse failure mode than
    // occasionally dropping one update on a DB hiccup.
    console.error(`telegram adapter: failed to claim update ${updateId} for integration ${integrationId}:`, error);
    return false;
  }
  // `ignoreDuplicates: true` makes this an `ON CONFLICT DO NOTHING` --
  // on a conflict (already claimed), PostgREST returns zero rows (not an
  // error), which is exactly the "someone already claimed this" signal.
  return (data?.length ?? 0) > 0;
}

/** Tolerates a trailing `@BotUsername` (Telegram appends this in group chats, and some clients send it in DMs too) and requires the command to start the message. Returns the lowercased command name without the leading slash, or null if `text` isn't a command at all. */
function extractCommand(text: string): string | null {
  const match = text.trim().match(/^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?(?:\s|$)/);
  return match ? match[1].toLowerCase() : null;
}

/**
 * ChannelAdapter.parseIncoming implementation. Order matters here and is
 * deliberate (cheapest/most-defensive checks first):
 *   1. Verify the webhook secret -- reject anything not genuinely from
 *      Telegram before doing ANY other work.
 *   2. Parse the JSON body.
 *   3. Claim update_id via channel_processed_updates BEFORE any further
 *      processing (dedup a Telegram retry, even for updates that will
 *      turn out to be ignored below -- claiming is idempotent-safe and
 *      cheap either way).
 *   4. Gate anything that isn't a plain text message (no `.message` at
 *      all -- edited_message/my_chat_member/channel_post/...; or a
 *      `.message` with no `.text` -- photo/sticker/document/...) to
 *      `{kind:"ignore"}` before ever touching `.text` further.
 */
async function parseIncoming(
  request: Request,
  integration: ChannelIntegrationConfig
): Promise<{ kind: "message"; message: IncomingChannelMessage } | { kind: "ignore" } | { kind: "unauthorized" }> {
  const credentials = integration.credentials as TelegramCredentials;

  if (!verifySecretToken(request, credentials.webhookSecret)) {
    return { kind: "unauthorized" };
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    // Malformed body -- nothing to process, and this isn't an
    // authenticity failure (the secret already verified above), so
    // "ignore" (not "unauthorized") is the honest classification.
    return { kind: "ignore" };
  }
  if (typeof update.update_id !== "number") {
    return { kind: "ignore" };
  }

  const supabase = getServiceRoleClient();
  const claimed = await claimUpdate(supabase, integration.id, update.update_id);
  if (!claimed) {
    return { kind: "ignore" };
  }

  const message = update.message;
  if (!message || typeof message.text !== "string" || message.text.trim().length === 0) {
    return { kind: "ignore" };
  }

  const chatId = String(message.chat.id);
  return {
    kind: "message",
    message: {
      channel: "telegram",
      externalParticipantId: chatId,
      text: message.text,
      replyTarget: chatId,
    },
  };
}

/** ChannelAdapter.sendReply implementation -- plain text only, see client.ts's own comment on why no `parse_mode`. */
async function sendReply(message: { replyTarget: unknown; text: string }, integration: ChannelIntegrationConfig): Promise<void> {
  const credentials = integration.credentials as TelegramCredentials;
  await sendTelegramMessage(credentials.botToken, String(message.replyTarget), message.text);
}

export const telegramChannelAdapter: ChannelAdapter = {
  channel: "telegram",
  parseIncoming,
  sendReply,
};

/**
 * Wraps sendReply in a try/catch that swallows-and-logs -- every outbound
 * Telegram API call in this file goes through this, never bare. Required
 * because the webhook route (app/api/channels/telegram/[integrationId]/route.ts)
 * always returns 200 regardless of internal outcome (Telegram retries on
 * any non-2xx or slow response -- a retry storm on top of an already-slow
 * RAG pipeline is exactly the failure mode to avoid); an outbound failure
 * here (e.g. the participant blocked the bot, or a transient Telegram API
 * hiccup) must never propagate into that response.
 */
async function safeSendReply(integration: ChannelIntegrationConfig, replyTarget: unknown, text: string): Promise<void> {
  try {
    await sendReply({ replyTarget, text }, integration);
  } catch (err) {
    console.error(`telegram adapter: failed to send a reply for integration ${integration.id}:`, err);
  }
}

/**
 * `/new`'s implementation: deletes the (project, 'telegram',
 * externalParticipantId) conversation row -- `messages.conversation_id`
 * cascades on delete (see the conversations/messages migration), so this
 * cleanly removes the whole thread. The NEXT message from this participant
 * then goes through lib/chat/handle-chat-request.ts's normal
 * find-or-create path (resolveExternalConversation) and creates a brand
 * new row with no memory of the old one -- "reset" without needing a
 * dedicated schema column for it.
 */
async function resetConversation(supabase: SupabaseClient, projectId: string, externalParticipantId: string): Promise<void> {
  const { error } = await supabase
    .from("conversations")
    .delete()
    .eq("project_id", projectId)
    .eq("channel", "telegram")
    .eq("external_participant_id", externalParticipantId);
  if (error) {
    console.error(
      `telegram adapter: failed to reset conversation for project ${projectId}, participant ${externalParticipantId}:`,
      error
    );
  }
}

/** Maps a gateway outcome to the (plain-text-only) reply text sent back to the participant. Every branch is a short, generic, static string -- deliberately never echoes internal error details or mentions "document"/"context"/"источник" (the system prompt already keeps that language out of the model's own answers project-wide; this is the adapter's OWN static copy staying consistent with that, for its own error-path strings, which the model never generates). */
function replyTextForGatewayResult(result: GatewayAnswerResult): string {
  switch (result.kind) {
    case "ok":
      return result.text;
    case "rate_limited":
      return RATE_LIMITED_REPLY;
    case "no_credentials":
      return NO_CREDENTIALS_REPLY;
    case "error":
      return GENERIC_ERROR_REPLY;
  }
}

/**
 * The concrete Telegram webhook orchestration
 * app/api/channels/telegram/[integrationId]/route.ts delegates to
 * entirely. Never throws (every internal step that can fail is either
 * itself swallow-and-log, per safeSendReply, or -- for parseIncoming/
 * answerExternalMessage -- already designed to resolve rather than
 * reject); the route wraps this call in its own top-level try/catch
 * anyway, as a defensive backstop, not as the primary error-handling
 * mechanism.
 */
export async function handleTelegramWebhook(request: Request, integration: ChannelIntegrationConfig): Promise<void> {
  const parsed = await parseIncoming(request, integration);
  if (parsed.kind !== "message") {
    // "ignore" (non-text update, duplicate, malformed body) or
    // "unauthorized" (bad/missing secret) -- nothing more to do either
    // way; the route still responds 200 regardless (see that route's own
    // header comment).
    return;
  }

  const { message } = parsed;
  const command = extractCommand(message.text);

  if (command === "start") {
    await safeSendReply(integration, message.replyTarget, START_MESSAGE);
    return;
  }
  if (command === "new") {
    const supabase = getServiceRoleClient();
    await resetConversation(supabase, integration.projectId, message.externalParticipantId);
    await safeSendReply(integration, message.replyTarget, NEW_CHAT_MESSAGE);
    return;
  }

  // Everything else: the one seam into the core RAG pipeline (see this
  // file's/lib/gateway/answer.ts's own import-boundary header comments).
  const result = await answerExternalMessage({
    projectId: integration.projectId,
    channel: "telegram",
    externalParticipantId: message.externalParticipantId,
    message: message.text,
  });

  await safeSendReply(integration, message.replyTarget, replyTextForGatewayResult(result));
}
