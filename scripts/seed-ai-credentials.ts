// scripts/seed-ai-credentials.ts
//
// Populates the seeded demo account's per-user AI-provider credentials
// (`ai_provider_credentials` / `user_settings`) from whichever of
// OPENAI_API_KEY / ANTHROPIC_API_KEY / VOYAGE_API_KEY / GEMINI_API_KEY are
// set in .env.local -- the SAME env vars that used to drive the old
// process-global `AI_PROVIDER` selection (lib/ai/index.ts). Now that every
// user (including the demo account) reads their own encrypted credentials
// from the DB instead, those env vars' only remaining job is feeding THIS
// script.
//
// Why this has to be a companion script and can't just live in
// supabase/seed.sql: seed.sql is plain SQL, with no access to
// process.env or this project's AES-256-GCM encryption code
// (lib/ai/crypto.ts) -- it cannot itself read a real API key out of
// .env.local and encrypt it. This script is the Node-side half of seeding
// the demo account, run separately (`npm run seed:ai-keys`) after
// `supabase db reset` has (re-)created the demo user.
//
// **This is a REQUIRED step, not an optional one** (see README "Running
// locally"): without it, the demo account has zero configured AI
// providers and hits the exact same 422 { error: "no_credentials" }
// "add a key" response/modal as any other brand-new, not-yet-configured
// user the very first time it tries to chat -- silently regressing the
// "git clone && npm i && .env.local && npm run dev just works" experience
// this project had before bring-your-own-key.
//
// Idempotent (safe to re-run any number of times, e.g. every time
// `supabase db reset` recreates the demo user from supabase/seed.sql):
//   - saveAIProviderCredential() upserts by (user_id, provider), so
//     re-running with the same .env.local just re-encrypts and overwrites
//     the same rows, never accumulating duplicates.
//   - active_ai_provider is only ever set if it isn't ALREADY set -- this
//     script never overwrites a choice a human already made (e.g. by
//     visiting /profile and picking a different provider for the demo
//     account on purpose).
//
// Run via `npm run seed:ai-keys`, which loads .env.local (Node's
// `--env-file`, same mechanism `npm run test:integration` already uses)
// and executes this file through scripts/run-seed-ai-credentials.mjs -- see
// that file's header for why a plain `node scripts/seed-ai-credentials.ts`
// wouldn't work on its own (extensionless internal lib/ai/ imports +
// neutralizing the `server-only` guard).

import "server-only";
import {
  saveAIProviderCredential,
  getActiveProvider,
  setActiveProvider,
  hasAIProviderCredential,
  type AIProviderCredentialType,
} from "../lib/ai/credentials";
import { getServiceRoleClient } from "../lib/supabase/service-client";

/** Fixed demo user id, created by supabase/seed.sql (demo@example.com) -- see that file's own comment block for the full local-dev-only rationale. */
const DEMO_USER_ID = "00000000-0000-0000-0000-000000000001";

const ENV_KEY_BY_PROVIDER: Record<AIProviderCredentialType, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  voyage: "VOYAGE_API_KEY",
  gemini: "GEMINI_API_KEY",
};

async function main(): Promise<void> {
  const supabase = getServiceRoleClient();
  const seededThisRun: AIProviderCredentialType[] = [];

  for (const provider of Object.keys(ENV_KEY_BY_PROVIDER) as AIProviderCredentialType[]) {
    const envKey = ENV_KEY_BY_PROVIDER[provider];
    const value = process.env[envKey];
    if (!value) {
      // Not an error -- CLAUDE.md/this script's own contract: skip
      // whichever provider(s) don't have a real key on hand rather than
      // failing the whole run. A demo environment with, say, only a Gemini
      // key still ends up fully usable.
      console.info(`seed-ai-credentials: ${envKey} not set in .env.local -- skipping '${provider}'.`);
      continue;
    }
    await saveAIProviderCredential(supabase, DEMO_USER_ID, provider, value);
    seededThisRun.push(provider);
    console.info(`seed-ai-credentials: stored an encrypted '${provider}' credential for the demo user.`);
  }

  const currentActive = await getActiveProvider(supabase, DEMO_USER_ID);
  if (currentActive) {
    console.info(
      `seed-ai-credentials: active_ai_provider is already '${currentActive}' -- leaving it as-is (this script never overrides a choice already made, e.g. via /profile).`
    );
    return;
  }

  // gemini preferred: as of the last live check (README "What's been
  // verified live"), it's the one provider with a real, working account
  // balance in this environment -- openai/anthropic are correctly wired
  // end-to-end but currently blocked on billing, so defaulting to either
  // of those would leave the demo account's very first chat message
  // failing with a real vendor error instead of a clean local success.
  const geminiIsConfigured =
    seededThisRun.includes("gemini") || (await hasAIProviderCredential(supabase, DEMO_USER_ID, "gemini"));
  if (!geminiIsConfigured) {
    console.warn(
      "seed-ai-credentials: GEMINI_API_KEY is not set (in this run or a previous one) -- cannot default " +
        "active_ai_provider to 'gemini'. Set GEMINI_API_KEY in .env.local and re-run `npm run seed:ai-keys`, " +
        "or pick a provider manually for the demo account via POST/PUT /api/profile/ai-providers once signed in as it."
    );
    return;
  }
  await setActiveProvider(supabase, DEMO_USER_ID, "gemini");
  console.info("seed-ai-credentials: set active_ai_provider = 'gemini' for the demo user.");
}

main()
  .then(() => {
    console.info("seed-ai-credentials: done.");
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error("seed-ai-credentials: failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
