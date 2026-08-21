// lib/rate-limit/__tests__/rate-limiter.integration.test.ts
//
// Runs against a REAL local Supabase (see README "Running the integration
// tests" / `npm run test:integration`). The unit test
// (rate-limiter.test.ts) fakes the Postgrest query builder; this verifies
// checkChatRateLimit against the real `usage_events` table/index/RLS
// grants (service_role SELECT+INSERT, no UPDATE/DELETE -- see the
// migration), including the append-only-log-as-counter design actually
// producing correct counts via COUNT(*) over a time window.
//
// PROJECTS PIVOT: checkChatRateLimit is project-scoped now (`usage_events.
// project_id`, "layer 1" -- the aggregate budget shared by a project's
// owner test chat and every external channel session of that project, see
// lib/gateway/answer.ts) -- every usage_events row inserted below carries a
// real `project_id` from lib/testing/integration-helpers.ts's
// createTestProject().

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkChatRateLimit } from "../rate-limiter";
import {
  createTestProject,
  createTestUser,
  deleteTestUser,
  hasIntegrationEnv,
  makeIntegrationSupabaseClient,
} from "../../testing/integration-helpers";

describe.skipIf(!hasIntegrationEnv())("checkChatRateLimit (integration, real Supabase)", () => {
  let supabase: SupabaseClient;
  let userId: string;
  let projectId: string;

  beforeAll(async () => {
    supabase = makeIntegrationSupabaseClient();
    const user = await createTestUser(supabase, "ratelimit");
    userId = user.id;
    projectId = (await createTestProject(supabase, userId)).id;
  });

  afterAll(async () => {
    if (userId) await deleteTestUser(supabase, userId);
  });

  async function insertEvent(overrides: {
    eventType?: "chat_request" | "embedding_request";
    ageMs?: number;
    projectId?: string;
  } = {}): Promise<void> {
    const createdAt = new Date(Date.now() - (overrides.ageMs ?? 0)).toISOString();
    const { error } = await supabase.from("usage_events").insert({
      project_id: overrides.projectId ?? projectId,
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

    const result = await checkChatRateLimit(supabase, projectId, { maxRequests: 3, windowMs: 60_000 });
    expect(result.currentCount).toBe(3);
    expect(result.allowed).toBe(false); // exactly at the limit
  });

  it("allows the request when raising maxRequests above the current count", async () => {
    const result = await checkChatRateLimit(supabase, projectId, { maxRequests: 4, windowMs: 60_000 });
    expect(result.currentCount).toBe(3);
    expect(result.allowed).toBe(true);
  });

  it("does not leak another project's events into the count (scoped by project_id, even under the SAME owner)", async () => {
    // Same owner as `projectId` above, but a SECOND, independent project --
    // this is the case that would NOT be caught by only testing two
    // different owners: isolation here is project-level, not account-level.
    const otherProject = await createTestProject(supabase, userId, "Other project");
    const { error } = await supabase.from("usage_events").insert({
      project_id: otherProject.id,
      user_id: userId,
      event_type: "chat_request",
      provider: "integration-fake",
      model: "integration-fake-model",
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    });
    if (error) throw new Error(error.message);

    const result = await checkChatRateLimit(supabase, otherProject.id, { maxRequests: 10, windowMs: 60_000 });
    expect(result.currentCount).toBe(1); // only otherProject's own event, not projectId's 3
  });
});
