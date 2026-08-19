// lib/rate-limit/__tests__/rate-limiter.integration.test.ts
//
// Runs against a REAL local Supabase (see README "Running the integration
// tests" / `npm run test:integration`). The unit test
// (rate-limiter.test.ts) fakes the Postgrest query builder; this verifies
// checkChatRateLimit against the real `usage_events` table/index/RLS
// grants (service_role SELECT+INSERT, no UPDATE/DELETE -- see the
// migration), including the append-only-log-as-counter design actually
// producing correct counts via COUNT(*) over a time window.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkChatRateLimit } from "../rate-limiter";
import {
  createTestUser,
  deleteTestUser,
  hasIntegrationEnv,
  makeIntegrationSupabaseClient,
} from "../../testing/integration-helpers";

describe.skipIf(!hasIntegrationEnv())("checkChatRateLimit (integration, real Supabase)", () => {
  let supabase: SupabaseClient;
  let userId: string;

  beforeAll(async () => {
    supabase = makeIntegrationSupabaseClient();
    const user = await createTestUser(supabase, "ratelimit");
    userId = user.id;
  });

  afterAll(async () => {
    if (userId) await deleteTestUser(supabase, userId);
  });

  async function insertEvent(overrides: {
    eventType?: "chat_request" | "embedding_request";
    ageMs?: number;
  } = {}): Promise<void> {
    const createdAt = new Date(Date.now() - (overrides.ageMs ?? 0)).toISOString();
    const { error } = await supabase.from("usage_events").insert({
      user_id: userId,
      event_type: overrides.eventType ?? "chat_request",
      provider: "integration-fake",
      model: "integration-fake-model",
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      created_at: createdAt,
    });
    if (error) throw new Error(`insertEvent failed: ${error.message}`);
  }

  it("counts only chat_request events within the window, ignoring embedding_request and stale events", async () => {
    // 3 chat_request events inside the last minute.
    await insertEvent({ ageMs: 50_000 });
    await insertEvent({ ageMs: 30_000 });
    await insertEvent({ ageMs: 10_000 });
    // 2 embedding_request events inside the same window -- must NOT count
    // towards the chat rate limit.
    await insertEvent({ eventType: "embedding_request", ageMs: 20_000 });
    await insertEvent({ eventType: "embedding_request", ageMs: 5_000 });
    // 1 chat_request event that's outside the 60s window -- must NOT count.
    await insertEvent({ ageMs: 120_000 });

    const result = await checkChatRateLimit(supabase, userId, { maxRequests: 3, windowMs: 60_000 });
    expect(result.currentCount).toBe(3);
    expect(result.allowed).toBe(false); // exactly at the limit
  });

  it("allows the request when raising maxRequests above the current count", async () => {
    const result = await checkChatRateLimit(supabase, userId, { maxRequests: 4, windowMs: 60_000 });
    expect(result.currentCount).toBe(3);
    expect(result.allowed).toBe(true);
  });

  it("does not leak other users' events into the count (scoped by user_id)", async () => {
    const otherUser = await createTestUser(supabase, "ratelimit-other");
    try {
      const { error } = await supabase.from("usage_events").insert({
        user_id: otherUser.id,
        event_type: "chat_request",
        provider: "integration-fake",
        model: "integration-fake-model",
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      });
      if (error) throw new Error(error.message);

      const result = await checkChatRateLimit(supabase, otherUser.id, { maxRequests: 10, windowMs: 60_000 });
      expect(result.currentCount).toBe(1); // only otherUser's own event, not userId's 3
    } finally {
      await deleteTestUser(supabase, otherUser.id);
    }
  });
});
