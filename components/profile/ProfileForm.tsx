"use client";

// components/profile/ProfileForm.tsx
//
// The /profile page's client-side content: loads
// GET /api/profile/ai-providers on mount (loading skeleton -> ready/error),
// then renders one section per provider slot (OpenAI, "Anthropic (+
// Voyage)" -- one section, two key fields, since that pairing is fixed --
// and Gemini) plus a read-only summary of which providers are fully
// configured (see ActiveProviderSection.tsx's own PROJECTS PIVOT DAMAGE
// CONTROL header comment for why that's no longer an interactive picker).
//
// Deliberately goes through app/api/profile/ai-providers/route.ts for
// everything, never lib/ai/credentials.ts directly -- same
// nextjs-frontend/rag-pipeline-specialist boundary as
// components/sources/* only ever calling app/api/sources/* routes, never
// lib/sources/credentials.ts.
//
// GET fetch + status-code branching goes through
// components/sources/request-helpers.ts's getJson() (shared with
// ModelPicker.tsx/TelegramChannelPanel.tsx) rather than hand-rolling its
// own fetch/401/429/!ok handling; per-provider display labels come from
// lib/ui/provider-metadata.ts's PROVIDER_DISPLAY_INFO (shared with
// ModelPicker.tsx/ActiveProviderSection.tsx) rather than being duplicated
// here as plain JSX text.

import { useEffect, useState } from "react";
import { redirectToLogin } from "@/lib/ui/client-redirect";
import { getJson } from "@/components/sources/request-helpers";
import { PROVIDER_DISPLAY_INFO } from "@/lib/ui/provider-metadata";
import { ProviderKeyField } from "./ProviderKeyField";
import { ActiveProviderSection } from "./ActiveProviderSection";
import type { AIProviderCredentialType, ConfiguredFlags } from "./types";

interface GetResponseBody {
  configured: ConfiguredFlags;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; configured: ConfiguredFlags };

/**
 * Pure request -> LoadState mapping, no setState of its own -- callers
 * (the mount effect below and the "Попробовать снова" retry button) are
 * the only ones that call setState, and only ever from a `.then()`
 * callback / event handler, never synchronously inside a `useEffect` body
 * (react-hooks/set-state-in-effect: calling setState directly, synchronously,
 * within an effect risks a cascading extra render -- see Sidebar.tsx's own
 * comment on the same rule for the other place this project already works
 * around it. Returning a value from an awaited async function and letting
 * the effect's `.then()` apply it keeps the actual state write outside the
 * effect's synchronous call stack).
 */
async function fetchProviderState(): Promise<LoadState> {
  const result = await getJson<GetResponseBody>("/api/profile/ai-providers");
  if (!result.ok) {
    if (result.kind === "unauthorized") {
      redirectToLogin();
      // Unreachable in practice -- redirectToLogin() is a hard navigation
      // (window.location.href), so the component unmounts before this
      // return value would ever be applied. Only here to satisfy the
      // return type.
      return { status: "loading" };
    }
    return { status: "error", message: result.message };
  }
  return { status: "ready", configured: result.data.configured };
}

export function ProfileForm() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void fetchProviderState().then((result) => {
      if (!cancelled) setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function handleRetry() {
    setState({ status: "loading" });
    void fetchProviderState().then((result) => setState(result));
  }

  if (state.status === "loading") {
    return <ProfileSkeleton />;
  }

  if (state.status === "error") {
    return (
      <div className="card empty-state" role="alert">
        <p>{state.message}</p>
        <div>
          <button type="button" className="btn btn-secondary" onClick={handleRetry}>
            Попробовать снова
          </button>
        </div>
      </div>
    );
  }

  const { configured } = state;

  function handleConfiguredChange(provider: AIProviderCredentialType, isConfigured: boolean) {
    setState((prev) =>
      prev.status === "ready" ? { ...prev, configured: { ...prev.configured, [provider]: isConfigured } } : prev
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <section className="card" aria-labelledby="provider-openai-heading">
        <h2 id="provider-openai-heading" className="provider-section-title">
          {PROVIDER_DISPLAY_INFO.openai.label}
        </h2>
        <p className="field-hint" style={{ marginBottom: "0.7rem" }}>
          Чат и поиск по документам через OpenAI (по умолчанию <code>gpt-4.1-mini</code> +{" "}
          <code>text-embedding-3-small</code>). Ключ — на{" "}
          <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">
            platform.openai.com → API keys
          </a>
          .
        </p>
        <ProviderKeyField
          provider="openai"
          label="OpenAI API key"
          configured={configured.openai}
          placeholder="sk-..."
          onConfiguredChange={handleConfiguredChange}
        />
      </section>

      <section className="card" aria-labelledby="provider-anthropic-heading">
        <h2 id="provider-anthropic-heading" className="provider-section-title">
          {PROVIDER_DISPLAY_INFO.anthropic.label}
        </h2>
        <p className="field-hint" style={{ marginBottom: "0.7rem" }}>
          У Anthropic нет собственных embeddings — для поиска по документам нужен ещё ключ Voyage AI.
          Оба нужны, чтобы использовать Anthropic в проекте. Ключи — на{" "}
          <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer">
            console.anthropic.com
          </a>{" "}
          и{" "}
          <a href="https://dashboard.voyageai.com/api-keys" target="_blank" rel="noopener noreferrer">
            dashboard.voyageai.com
          </a>
          .
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.9rem" }}>
          <ProviderKeyField
            provider="anthropic"
            label="Anthropic API key"
            configured={configured.anthropic}
            placeholder="sk-ant-..."
            onConfiguredChange={handleConfiguredChange}
          />
          <ProviderKeyField
            provider="voyage"
            label="Voyage API key"
            configured={configured.voyage}
            placeholder="pa-..."
            onConfiguredChange={handleConfiguredChange}
          />
        </div>
      </section>

      <section className="card" aria-labelledby="provider-gemini-heading">
        <h2 id="provider-gemini-heading" className="provider-section-title">
          {PROVIDER_DISPLAY_INFO.gemini.label}
        </h2>
        <p className="field-hint" style={{ marginBottom: "0.7rem" }}>
          Чат и поиск по документам через Gemini. Ключ — в{" "}
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">
            Google AI Studio
          </a>
          .
        </p>
        <ProviderKeyField
          provider="gemini"
          label="Gemini API key"
          configured={configured.gemini}
          placeholder="AIza..."
          onConfiguredChange={handleConfiguredChange}
        />
      </section>

      <section className="card">
        <ActiveProviderSection configured={configured} />
      </section>
    </div>
  );
}

function ProfileSkeleton() {
  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}
      aria-busy="true"
      aria-label="Загрузка настроек AI-провайдеров"
    >
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="card" style={{ height: "6rem" }}>
          <div className="skeleton" style={{ height: "100%", width: "100%" }} />
        </div>
      ))}
    </div>
  );
}
