// lib/ai/__tests__/get-configured-providers-map.test.ts
//
// Unit test for getConfiguredProvidersMap() -- the shared "is X configured"
// map extracted out of what used to be independently re-implemented
// `Promise.all(...).map` + `Object.fromEntries` logic in both
// app/api/profile/ai-providers/route.ts and
// app/api/projects/[projectId]/model/route.ts. Exercised here against a
// fake Supabase client (mirroring hasAIProviderCredential's own real query
// shape) rather than mocking hasAIProviderCredential itself, since that
// function is a plain same-module call from getConfiguredProvidersMap, not
// a re-import through a mockable module boundary.

import { describe, expect, it } from "vitest";
import { getConfiguredProvidersMap, ALL_CREDENTIAL_PROVIDERS } from "../credentials";
import type { SupabaseClient } from "@supabase/supabase-js";

function fakeSupabase(configuredProviders: Set<string>) {
  const calls: string[] = [];
  return {
    from(table: string) {
      if (table !== "ai_provider_credentials") throw new Error(`unexpected table: ${table}`);
      let provider: string | undefined;
      return {
        select() {
          return this;
        },
        eq(column: string, value: string) {
          if (column === "provider") provider = value;
          return this;
        },
        then(resolve: (result: { count: number; error: null }) => void) {
          calls.push(provider as string);
          resolve({ count: configuredProviders.has(provider as string) ? 1 : 0, error: null });
        },
      };
    },
    __calls: calls,
  } as unknown as SupabaseClient & { __calls: string[] };
}

describe("getConfiguredProvidersMap", () => {
  it("returns a boolean for every provider in ALL_CREDENTIAL_PROVIDERS", async () => {
    const supabase = fakeSupabase(new Set(["openai", "voyage"]));
    const result = await getConfiguredProvidersMap(supabase, "user-1");
    expect(result).toEqual({ openai: true, anthropic: false, gemini: false, voyage: true });
  });

  it("checks every provider concurrently (one query per provider, not skipped once one is found)", async () => {
    const supabase = fakeSupabase(new Set()) as ReturnType<typeof fakeSupabase>;
    await getConfiguredProvidersMap(supabase, "user-1");
    expect(supabase.__calls.sort()).toEqual([...ALL_CREDENTIAL_PROVIDERS].sort());
  });

  it("returns all-false when nothing is configured", async () => {
    const supabase = fakeSupabase(new Set());
    const result = await getConfiguredProvidersMap(supabase, "user-1");
    expect(result).toEqual({ openai: false, anthropic: false, gemini: false, voyage: false });
  });
});
