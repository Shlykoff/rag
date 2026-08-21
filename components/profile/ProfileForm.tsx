"use client";

// components/profile/ProfileForm.tsx
//
// The /profile page's client-side content: loads
// GET /api/profile/ai-providers on mount (loading skeleton -> ready/error),
// then renders one section per provider slot (OpenAI, "Anthropic (+
// Voyage)" -- one section, two key fields, since that pairing is fixed --
// and Gemini) plus the active-provider picker.
//
// Deliberately goes through app/api/profile/ai-providers/route.ts for
// everything, never lib/ai/credentials.ts directly -- same
// nextjs-frontend/rag-pipeline-specialist boundary as
// components/sources/* only ever calling app/api/sources/* routes, never
// lib/sources/credentials.ts.

import { useEffect, useState } from "react";
import { redirectToLogin } from "@/lib/ui/client-redirect";
import { ProviderKeyField } from "./ProviderKeyField";
import { ActiveProviderSection } from "./ActiveProviderSection";
import type { AIProviderCredentialType, ActiveAIProvider, ConfiguredFlags } from "./types";

interface GetResponseBody {
  configured: ConfiguredFlags;
  activeProvider: ActiveAIProvider | null;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; configured: ConfiguredFlags; activeProvider: ActiveAIProvider | null };

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
  try {
    const response = await fetch("/api/profile/ai-providers");
    if (response.status === 401) {
      redirectToLogin();
      // Unreachable in practice -- redirectToLogin() is a hard navigation
      // (window.location.href), so the component unmounts before this
      // return value would ever be applied. Only here to satisfy the
      // return type.
      return { status: "loading" };
    }
    if (response.status === 429) {
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      return { status: "error", message: body.message ?? "Слишком много запросов. Попробуйте чуть позже." };
    }
    if (!response.ok) {
      return {
        status: "error",
        message: "Не удалось загрузить настройки AI-провайдеров. Попробуйте обновить страницу.",
      };
    }
    const data = (await response.json()) as GetResponseBody;
    return { status: "ready", configured: data.configured, activeProvider: data.activeProvider };
  } catch {
    return {
      status: "error",
      message: "Не удалось подключиться к серверу. Проверьте, что Supabase запущен, и обновите страницу.",
    };
  }
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

  const { configured, activeProvider } = state;

  function handleConfiguredChange(provider: AIProviderCredentialType, isConfigured: boolean) {
    setState((prev) =>
      prev.status === "ready" ? { ...prev, configured: { ...prev.configured, [provider]: isConfigured } } : prev
    );
  }

  function handleActiveProviderChange(provider: ActiveAIProvider) {
    setState((prev) => (prev.status === "ready" ? { ...prev, activeProvider: provider } : prev));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <section className="card" aria-labelledby="provider-openai-heading">
        <h2 id="provider-openai-heading" className="provider-section-title">
          OpenAI
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
          onActiveProviderChange={handleActiveProviderChange}
        />
      </section>

      <section className="card" aria-labelledby="provider-anthropic-heading">
        <h2 id="provider-anthropic-heading" className="provider-section-title">
          Anthropic Claude (+ Voyage AI для embeddings)
        </h2>
        <p className="field-hint" style={{ marginBottom: "0.7rem" }}>
          У Anthropic нет собственных embeddings — для поиска по документам нужен ещё ключ Voyage AI.
          Оба нужны, чтобы выбрать Anthropic активным провайдером ниже. Ключи — на{" "}
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
            onActiveProviderChange={handleActiveProviderChange}
          />
          <ProviderKeyField
            provider="voyage"
            label="Voyage API key"
            configured={configured.voyage}
            placeholder="pa-..."
            onConfiguredChange={handleConfiguredChange}
            onActiveProviderChange={handleActiveProviderChange}
          />
        </div>
      </section>

      <section className="card" aria-labelledby="provider-gemini-heading">
        <h2 id="provider-gemini-heading" className="provider-section-title">
          Google Gemini
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
          onActiveProviderChange={handleActiveProviderChange}
        />
      </section>

      <section className="card">
        <ActiveProviderSection
          configured={configured}
          activeProvider={activeProvider}
          onActiveProviderChange={handleActiveProviderChange}
        />
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
