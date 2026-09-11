"use client";

// components/profile/ProfileForm.tsx
//
// The /profile page's client-side content: loads
// GET /api/profile/ai-providers on mount (loading skeleton -> ready/error),
// then renders one key field per provider plus a summary of what the saved
// keys cover (ActiveProviderSection.tsx). Which concrete models a project
// uses is chosen on that project's own model page, not here.
//
// Goes through app/api/profile/ai-providers/route.ts for everything, never
// lib/ai/credentials.ts directly.

import { useEffect, useState } from "react";
import { redirectToLogin } from "@/lib/ui/client-redirect";
import { getJson } from "@/components/sources/request-helpers";
import { PROVIDER_LABELS, describeProviderCapabilities } from "@/lib/ui/provider-metadata";
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

interface ProviderSection {
  provider: AIProviderCredentialType;
  keyLabel: string;
  placeholder: string;
  /** Where the user gets a key: "Ключ — на <link>" / "Ключ — в <link>". */
  keyWhere: "на" | "в";
  keyUrl: string;
  keyUrlLabel: string;
  note?: string;
}

const PROVIDER_SECTIONS: readonly ProviderSection[] = [
  {
    provider: "openai",
    keyLabel: "OpenAI API key",
    placeholder: "sk-...",
    keyWhere: "на",
    keyUrl: "https://platform.openai.com/api-keys",
    keyUrlLabel: "platform.openai.com → API keys",
  },
  {
    provider: "anthropic",
    keyLabel: "Anthropic API key",
    placeholder: "sk-ant-...",
    keyWhere: "на",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyUrlLabel: "console.anthropic.com",
    note: "Своих эмбеддингов у Anthropic нет: для поиска по документам проекту понадобится ещё ключ OpenAI, Gemini или Voyage AI.",
  },
  {
    provider: "gemini",
    keyLabel: "Gemini API key",
    placeholder: "AIza...",
    keyWhere: "в",
    keyUrl: "https://aistudio.google.com/apikey",
    keyUrlLabel: "Google AI Studio",
  },
  {
    provider: "voyage",
    keyLabel: "Voyage API key",
    placeholder: "pa-...",
    keyWhere: "на",
    keyUrl: "https://dashboard.voyageai.com/api-keys",
    keyUrlLabel: "dashboard.voyageai.com",
    note: "Сочетается с моделью чата любого провайдера.",
  },
];

// Returns the state instead of setting it, so the effect below only calls
// setState from a .then() callback, never synchronously in its body.
async function fetchProviderState(): Promise<LoadState> {
  const result = await getJson<GetResponseBody>("/api/profile/ai-providers");
  if (!result.ok) {
    if (result.kind === "unauthorized") {
      redirectToLogin();
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
      {PROVIDER_SECTIONS.map((section) => {
        const headingId = `provider-${section.provider}-heading`;
        const capabilities = describeProviderCapabilities(section.provider);
        return (
          <section key={section.provider} className="card" aria-labelledby={headingId}>
            <h2 id={headingId} className="provider-section-title">
              {PROVIDER_LABELS[section.provider]}
            </h2>
            <p className="field-hint" style={{ marginBottom: "0.7rem" }}>
              Даёт проектам: {capabilities}.{section.note ? ` ${section.note}` : ""} Ключ — {section.keyWhere}{" "}
              <a href={section.keyUrl} target="_blank" rel="noopener noreferrer">
                {section.keyUrlLabel}
              </a>
              .
            </p>
            <ProviderKeyField
              provider={section.provider}
              label={section.keyLabel}
              configured={configured[section.provider]}
              placeholder={section.placeholder}
              onConfiguredChange={handleConfiguredChange}
            />
          </section>
        );
      })}

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
