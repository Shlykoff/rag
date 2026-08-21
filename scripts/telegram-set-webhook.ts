// scripts/telegram-set-webhook.ts
//
// Bootstrap script for ONE project's Telegram integration -- mirrors
// scripts/seed-ai-credentials.ts's precedent (a one-off Node script for
// backend setup that has no UI yet; Stage C/nextjs-frontend builds the
// real "connect Telegram" screen under /projects/[projectId]/channels).
// This is backend tooling, not UI, per this task's explicit scope.
//
// Run via (see package.json's "telegram:set-webhook" script, which loads
// .env.local the same way `npm run seed:ai-keys` does):
//   npm run telegram:set-webhook -- --project <projectId> --token <bot-api-token> --url <public-https-base-url>
//
// What it does, in order:
//   1. Generates a fresh random webhook secret (crypto.randomBytes(32)) --
//      or reuses the one already stored for this project's integration, if
//      re-run to rotate just the bot token.
//   2. Saves { botToken, webhookSecret } encrypted into `channel_integrations`
//      (lib/channels/telegram/integration-store.ts) -- upserts by
//      (project_id, channel), so re-running this script is safe (never
//      accumulates duplicate rows).
//   3. Calls Telegram's setWebhook with
//      url = `${baseUrl}/api/channels/telegram/{integrationId}` and
//      secret_token = the SAME webhook secret just saved -- this is what
//      makes lib/channels/telegram/adapter.ts's crypto.timingSafeEqual
//      check against the stored secret line up with what Telegram will
//      actually send in the X-Telegram-Bot-Api-Secret-Token header on
//      every delivery.
//
// LOCAL DEV NOTE (open item requiring the user's own action -- see the
// architecture plan's "Open items"): Telegram cannot reach `localhost`
// directly -- `--url` must be a public HTTPS tunnel (ngrok, cloudflared,
// ...) pointed at your local dev server, e.g. `ngrok http 3000` and then
// `--url https://<random>.ngrok-free.app`. See README "Telegram" for the
// exact command once nextjs-frontend documents the full local setup flow.
//
// GROUP CHATS ARE OUT OF SCOPE for this MVP (CLAUDE.md's explicit
// boundary, matching the rest of this project's "sознательные границы,
// не недоделанные фичи" posture): when creating the bot via @BotFather,
// disable "Allow Groups?" (send BotFather `/setjoingroups` -> Disable) so
// the bot can't be added to group chats at all. This script cannot enforce
// that itself (it's a one-time BotFather setting, not a Bot API call) --
// it only prints a reminder at the end.
//
// Run via a tiny esbuild-based bootstrapper (scripts/run-telegram-set-webhook.mjs),
// same reasoning as scripts/run-seed-ai-credentials.mjs's own header: this
// project's lib/ code uses extensionless imports (bundler-resolved) and
// `import "server-only"` (which unconditionally throws outside a bundler
// that maps it to its React-Server-Components no-op) -- plain
// `node scripts/telegram-set-webhook.ts` can't resolve either on its own.

import "server-only";
import { randomBytes } from "node:crypto";
import { getServiceRoleClient } from "../lib/supabase/service-client";
import { getTelegramIntegrationByProject, saveTelegramIntegration } from "../lib/channels/telegram/integration-store";
import { setTelegramWebhook } from "../lib/channels/telegram/client";

interface CliArgs {
  projectId: string;
  botToken: string;
  baseUrl: string;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (name: string): string | undefined => {
    const idx = argv.indexOf(`--${name}`);
    return idx !== -1 ? argv[idx + 1] : undefined;
  };
  const projectId = get("project");
  const botToken = get("token");
  const baseUrl = get("url");
  if (!projectId || !botToken || !baseUrl) {
    throw new Error(
      "Usage: npm run telegram:set-webhook -- --project <projectId> --token <bot-api-token> --url <public-https-base-url>\n" +
        "  --url must be a public HTTPS base (e.g. an ngrok tunnel) -- Telegram cannot reach localhost directly."
    );
  }
  if (!baseUrl.startsWith("https://")) {
    throw new Error(`--url must be an https:// URL (Telegram requires HTTPS for webhooks), got: ${baseUrl}`);
  }
  return { projectId, botToken, baseUrl: baseUrl.replace(/\/+$/, "") };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const supabase = getServiceRoleClient();

  // Reuse the existing webhook secret when this project already has a
  // Telegram integration (e.g. re-running this script just to rotate the
  // bot token) -- generating a NEW secret every run would require also
  // re-registering the webhook (harmless, this script always does that
  // anyway) but would silently invalidate the old secret with no
  // corresponding user-visible signal; reusing it when possible keeps
  // "rotate just the token" and "set up fresh" behaving predictably
  // differently.
  const existing = await getTelegramIntegrationByProject(supabase, args.projectId);
  const webhookSecret = existing?.credentials.webhookSecret ?? randomBytes(32).toString("hex");
  console.info(
    existing
      ? `telegram-set-webhook: reusing the existing webhook secret for project ${args.projectId} (rotating the bot token).`
      : `telegram-set-webhook: generated a fresh webhook secret for project ${args.projectId}.`
  );

  const { id: integrationId } = await saveTelegramIntegration(
    supabase,
    args.projectId,
    { botToken: args.botToken, webhookSecret },
    existing?.displayLabel ?? null
  );
  console.info(`telegram-set-webhook: saved encrypted integration ${integrationId} for project ${args.projectId}.`);

  const webhookUrl = `${args.baseUrl}/api/channels/telegram/${integrationId}`;
  await setTelegramWebhook(args.botToken, webhookUrl, webhookSecret);
  console.info(`telegram-set-webhook: registered webhook ${webhookUrl} with Telegram.`);
  console.info(
    'telegram-set-webhook: reminder -- disable "Allow Groups?" for this bot via @BotFather ' +
      "(send it /setjoingroups -> Disable); group-chat support is explicitly out of scope for this MVP."
  );
}

main()
  .then(() => {
    console.info("telegram-set-webhook: done.");
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error("telegram-set-webhook: failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
