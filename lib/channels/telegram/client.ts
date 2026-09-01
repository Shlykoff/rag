// lib/channels/telegram/client.ts
//
// Raw `fetch` wrapper over the Telegram Bot API (https://api.telegram.org/bot<token>/...)
// -- deliberately no SDK dependency. Three calls: sendMessage (outbound
// replies), setWebhook (used by scripts/telegram-set-webhook.ts and
// app/api/projects/[projectId]/channels/telegram/route.ts's POST -- not
// called on every request), and getWebhookInfo (used by that same route's
// GET, to report Telegram's OWN live view of whether a webhook is actually
// registered -- see that route's header comment for why this exists: a
// saved credential row alone doesn't prove Telegram ever accepted the
// webhook, or that it's still registered later). This file has no
// error-swallowing of its own: every function here either resolves or
// throws a plain Error describing the failure; it's the CALLER's job to
// decide whether that's fatal (scripts/telegram-set-webhook.ts, run
// interactively) or something to catch-log-and-continue
// (lib/channels/telegram/adapter.ts's webhook path, which must never let
// an outbound failure propagate into a non-200 response -- see that file's
// own try/catch around every call here; the channels route's GET handler
// takes the same catch-and-degrade approach for getWebhookInfo).

import "server-only";

const TELEGRAM_API_BASE = "https://api.telegram.org";
// Telegram's documented hard limit on a single message's text length. A
// reply longer than this is split into multiple sendMessage calls (see
// splitTelegramMessage / sendTelegramMessage below) rather than truncated
// or rejected.
const TELEGRAM_MESSAGE_MAX_LENGTH = 4096;

function botApiUrl(botToken: string, method: string): string {
  return `${TELEGRAM_API_BASE}/bot${botToken}/${method}`;
}

/** Best-effort redaction so a thrown error's message never contains the live bot token, even though it's already embedded in the request URL this function builds -- errors from this module can end up in server logs. */
function redactToken(url: string, botToken: string): string {
  return url.replace(botToken, "<redacted>");
}

async function callTelegramApi(botToken: string, method: string, body: Record<string, unknown>): Promise<unknown> {
  const url = botApiUrl(botToken, method);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`Telegram API ${method} network error: ${err instanceof Error ? err.message : String(err)} (${redactToken(url, botToken)})`);
  }
  const payload = (await response.json().catch(() => null)) as { ok?: boolean; description?: string; result?: unknown } | null;
  if (!response.ok || !payload?.ok) {
    throw new Error(
      `Telegram API ${method} failed (${response.status}): ${payload?.description ?? "unknown error"} (${redactToken(url, botToken)})`
    );
  }
  return payload;
}

/**
 * Splits `text` into chunks no longer than `maxLength`, preferring to break
 * at a paragraph boundary, then a line boundary, then a word boundary,
 * falling back to a hard cut only if none of those exist within the limit
 * (e.g. one extremely long unbroken line). Pure function, no I/O -- unit
 * tested directly.
 */
export function splitTelegramMessage(text: string, maxLength: number = TELEGRAM_MESSAGE_MAX_LENGTH): string[] {
  if (text.length <= maxLength) return text.length > 0 ? [text] : [];

  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    const window = remaining.slice(0, maxLength);
    let cut =
      window.lastIndexOf("\n\n") > 0
        ? window.lastIndexOf("\n\n")
        : window.lastIndexOf("\n") > 0
          ? window.lastIndexOf("\n")
          : window.lastIndexOf(" ") > 0
            ? window.lastIndexOf(" ")
            : -1;
    if (cut <= 0) {
      cut = maxLength; // no good boundary at all -- hard cut
      // A hard cut can land in the middle of a UTF-16 surrogate pair (e.g.
      // many emoji, which JS strings represent as two 16-bit code units) --
      // `.slice(0, cut)` would silently split the pair, corrupting both
      // resulting halves into lone unpaired surrogates. Back off one
      // character so the cut lands strictly before the pair instead.
      const before = remaining.charCodeAt(cut - 1);
      const after = remaining.charCodeAt(cut);
      const isHighSurrogate = before >= 0xd800 && before <= 0xdbff;
      const isLowSurrogate = after >= 0xdc00 && after <= 0xdfff;
      if (isHighSurrogate && isLowSurrogate) cut -= 1;
    }
    const chunk = remaining.slice(0, cut).trimEnd();
    if (chunk.length > 0) parts.push(chunk);
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) parts.push(remaining);
  return parts;
}

/**
 * Sends `text` to `chatId`, splitting into multiple messages if it exceeds
 * Telegram's length limit (sent in order, awaited sequentially so they
 * arrive in the right sequence). Deliberately plain text only -- NO
 * `parse_mode` -- see lib/channels/telegram/adapter.ts's own comment on
 * why: LLM output isn't guaranteed to be escaped for MarkdownV2/HTML, and
 * a 400 from a malformed `parse_mode` payload here means the participant
 * gets nothing back for an otherwise-successful turn.
 */
export async function sendTelegramMessage(botToken: string, chatId: string, text: string): Promise<void> {
  const chunks = splitTelegramMessage(text);
  for (const chunk of chunks) {
    await callTelegramApi(botToken, "sendMessage", { chat_id: chatId, text: chunk });
  }
}

/**
 * Registers `webhookUrl` as this bot's webhook, with `secretToken` set as
 * Telegram's `secret_token` (echoed back on every delivery as the
 * `X-Telegram-Bot-Api-Secret-Token` header -- see adapter.ts's
 * verification of it). Used only by scripts/telegram-set-webhook.ts, never
 * at request time.
 */
export async function setTelegramWebhook(botToken: string, webhookUrl: string, secretToken: string): Promise<void> {
  await callTelegramApi(botToken, "setWebhook", {
    url: webhookUrl,
    secret_token: secretToken,
    allowed_updates: ["message"],
  });
}

/**
 * Returns Telegram's OWN current record of this bot's registered webhook
 * URL ("" if none is set at all) -- the authoritative source of truth for
 * "is a webhook actually live", as opposed to inferring it from whether
 * this app once successfully called setWebhook in the past (which can go
 * stale: the token can be revoked, the webhook can be cleared via
 * BotFather, or overwritten by something outside this app entirely).
 * Used by app/api/projects/[projectId]/channels/telegram/route.ts's GET
 * handler -- see that route's header comment for why status is checked
 * live here instead of cached in a DB column.
 */
export async function getTelegramWebhookInfo(botToken: string): Promise<{ url: string }> {
  const payload = (await callTelegramApi(botToken, "getWebhookInfo", {})) as { result?: { url?: unknown } };
  const url = payload.result?.url;
  return { url: typeof url === "string" ? url : "" };
}
