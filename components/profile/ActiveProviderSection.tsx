"use client";

// components/profile/ActiveProviderSection.tsx
//
// Radio picker for `user_settings.active_ai_provider`, calling PUT
// /api/profile/ai-providers. Only providers that are actually fully
// configured are selectable (openai/gemini: their own key; anthropic:
// BOTH its own key AND a voyage key -- see app/api/profile/ai-providers/
// route.ts's PUT contract and lib/ai/credentials.ts's setActiveProvider()).
//
// The UI never lets you click a disabled (not-yet-configured) option, but
// PUT can still race (e.g. the key was deleted in another tab a moment
// before this click resolves) -- `400 { error: "missing_credentials",
// message }` is handled explicitly below with a plain-language message
// instead of surfacing that response's raw `message`, which is an
// internal-log-style string (see MissingProviderCredentialsError's
// constructor in lib/ai/credentials.ts) not meant for end users.

import { useState } from "react";
import { putJson, retryAfterSuffix } from "@/components/sources/request-helpers";
import { redirectToLogin } from "@/lib/ui/client-redirect";
import type { ActiveAIProvider, ConfiguredFlags } from "./types";

export interface ActiveProviderSectionProps {
  configured: ConfiguredFlags;
  activeProvider: ActiveAIProvider | null;
  onActiveProviderChange: (provider: ActiveAIProvider) => void;
}

interface ProviderOption {
  value: ActiveAIProvider;
  label: string;
  available: boolean;
  unavailableHint: string;
}

export function ActiveProviderSection({ configured, activeProvider, onActiveProviderChange }: ActiveProviderSectionProps) {
  const [saving, setSaving] = useState<ActiveAIProvider | null>(null);
  const [error, setError] = useState<string | null>(null);

  const options: ProviderOption[] = [
    {
      value: "openai",
      label: "OpenAI",
      available: configured.openai,
      unavailableHint: "сначала добавьте ключ OpenAI выше",
    },
    {
      value: "anthropic",
      label: "Anthropic Claude (+ Voyage AI для embeddings)",
      available: configured.anthropic && configured.voyage,
      unavailableHint: "нужны оба ключа: Anthropic и Voyage",
    },
    {
      value: "gemini",
      label: "Google Gemini",
      available: configured.gemini,
      unavailableHint: "сначала добавьте ключ Gemini выше",
    },
  ];

  async function handleSelect(provider: ActiveAIProvider) {
    setError(null);
    setSaving(provider);
    const result = await putJson<{ status: string; activeProvider: ActiveAIProvider }>("/api/profile/ai-providers", {
      activeProvider: provider,
    });
    setSaving(null);
    if (!result.ok) {
      if (result.kind === "unauthorized") {
        redirectToLogin();
        return;
      }
      if (result.kind === "error" && result.code === "missing_credentials") {
        setError(
          "Не удалось выбрать этого провайдера — не все нужные ключи сохранены (для Anthropic нужны оба: Anthropic и Voyage). Обновите страницу и попробуйте снова."
        );
        return;
      }
      setError(result.message + retryAfterSuffix(result.retryAfterMs));
      return;
    }
    onActiveProviderChange(provider);
  }

  return (
    <fieldset className="provider-active-fieldset">
      <legend className="provider-section-title">Активный провайдер</legend>
      <p className="field-hint">
        Используется для всех ваших запросов к ассистенту — чата и поиска по документам. Доступны только
        полностью настроенные провайдеры.
      </p>
      <div
        role="radiogroup"
        aria-label="Выбор активного AI-провайдера"
        style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "0.6rem" }}
      >
        {options.map((option) => {
          const checked = activeProvider === option.value;
          const disabled = !option.available || saving !== null;
          return (
            <label
              key={option.value}
              className={`provider-active-option${checked ? " provider-active-option-checked" : ""}`}
            >
              <input
                type="radio"
                name="active-provider"
                value={option.value}
                checked={checked}
                disabled={disabled}
                onChange={() => handleSelect(option.value)}
              />
              <span>
                {option.label}
                {saving === option.value ? " — сохраняем…" : null}
                {!option.available ? <span className="field-hint"> ({option.unavailableHint})</span> : null}
              </span>
            </label>
          );
        })}
      </div>
      {error ? (
        <p className="alert alert-danger" role="alert" style={{ marginTop: "0.6rem" }}>
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
