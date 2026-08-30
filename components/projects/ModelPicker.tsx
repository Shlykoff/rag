"use client";

// components/projects/ModelPicker.tsx
//
// Reads/sets THIS project's `active_ai_provider` via
// GET/PUT /api/projects/{projectId}/model (see that route's own header for
// the exact contract) -- never lib/ai/credentials.ts directly, per this
// stage's boundary rule ("use client" components fetch from a dedicated
// /api/* route on mount, same as components/profile/ProfileForm.tsx's own
// header comment states explicitly).
//
// Three states worth calling out:
//   1. Nothing connected at the ACCOUNT level at all (every `configured`
//      flag false) -- the picker has literally nothing to offer, so this
//      renders a dedicated "connect a provider first" banner pointing at
//      /profile instead of an empty/all-disabled radio list a user would
//      have to guess the meaning of.
//   2. Some providers connected, none usable for a specific pick (e.g. only
//      an 'anthropic' key without the paired 'voyage' one) -- that option
//      renders visibly but disabled, with its own short "чего не хватает"
//      hint (mirrors ActiveProviderSection.tsx's pre-pivot styling
//      conventions, .model-option-unavailable/.badge-neutral).
//   3. PUT's `400 { error: "missing_credentials" }` race (e.g. the owner
//      deleted a credential in another tab between this page's load and the
//      click) -- surfaced as a real inline error with the server's own
//      actionable message + a link to /profile, never a raw error dump.

import { useEffect, useState } from "react";
import Link from "next/link";
import { redirectToLogin } from "@/lib/ui/client-redirect";
// Type-only import -- lib/ai/index.ts transitively re-exports from
// lib/ai/credentials.ts, which is `import "server-only"`-tagged; a runtime
// (value) import of anything from "@/lib/ai" here would pull that into
// this "use client" bundle and fail the build. Type-only imports are
// erased at compile time (same pattern components/profile/types.ts already
// documents for itself), so labels below are duplicated locally (matching
// OPTIONS' own `label` field, sourced from lib/ai/index.ts's
// PROVIDER_REGISTRY) rather than calling the server-only getProviderLabel().
import type { ActiveAIProvider, AIProviderCredentialType } from "@/lib/ai";

type ConfiguredFlags = Record<AIProviderCredentialType, boolean>;

interface GetResponseBody {
  activeProvider: ActiveAIProvider | null;
  configured: ConfiguredFlags;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; activeProvider: ActiveAIProvider | null; configured: ConfiguredFlags };

const OPTIONS: { id: ActiveAIProvider; label: string; requires: AIProviderCredentialType[] }[] = [
  { id: "openai", label: "OpenAI", requires: ["openai"] },
  { id: "anthropic", label: "Anthropic Claude (+ Voyage AI для embeddings)", requires: ["anthropic", "voyage"] },
  { id: "gemini", label: "Google Gemini", requires: ["gemini"] },
];

async function fetchModelState(projectId: string): Promise<LoadState> {
  try {
    const response = await fetch(`/api/projects/${projectId}/model`);
    if (response.status === 401) {
      redirectToLogin();
      return { status: "loading" };
    }
    if (response.status === 404) {
      return { status: "error", message: "Проект не найден — возможно, он был удалён в другой вкладке." };
    }
    if (!response.ok) {
      return { status: "error", message: "Не удалось загрузить настройки модели. Попробуйте обновить страницу." };
    }
    const data = (await response.json()) as GetResponseBody;
    return { status: "ready", activeProvider: data.activeProvider, configured: data.configured };
  } catch {
    return {
      status: "error",
      message: "Не удалось подключиться к серверу. Проверьте, что Supabase запущен, и обновите страницу.",
    };
  }
}

export function ModelPicker({ projectId }: { projectId: string }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [saving, setSaving] = useState<ActiveAIProvider | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchModelState(projectId).then((result) => {
      if (!cancelled) setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  function handleRetry() {
    setState({ status: "loading" });
    void fetchModelState(projectId).then((result) => setState(result));
  }

  if (state.status === "loading") {
    return <ModelPickerSkeleton />;
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

  const { activeProvider, configured } = state;
  const nothingConfiguredAtAll = !configured.openai && !configured.anthropic && !configured.gemini && !configured.voyage;

  async function handleSelect(provider: ActiveAIProvider) {
    if (provider === activeProvider || saving) return;
    setSaving(provider);
    setSaveError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/model`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      if (response.status === 401) {
        redirectToLogin();
        return;
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
        if (body.error === "missing_credentials") {
          setSaveError(body.message ?? "Сначала подключите нужный ключ в профиле.");
          return;
        }
        setSaveError(body.message ?? "Не удалось обновить модель проекта. Попробуйте ещё раз.");
        return;
      }
      setState((prev) => (prev.status === "ready" ? { ...prev, activeProvider: provider } : prev));
    } catch {
      setSaveError("Не удалось подключиться к серверу.");
    } finally {
      setSaving(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <section className="card">
        <h1 style={{ fontSize: "1.05rem", marginBottom: "0.4rem" }}>Модель проекта</h1>
        <p className="field-hint">
          Сейчас активна:{" "}
          <strong>
            {activeProvider ? (OPTIONS.find((o) => o.id === activeProvider)?.label ?? activeProvider) : "модель ещё не выбрана"}
          </strong>
        </p>
      </section>

      {nothingConfiguredAtAll ? (
        <div className="alert alert-danger" role="alert">
          <p style={{ margin: 0 }}>
            К вашему аккаунту пока не подключён ни один AI-провайдер, поэтому выбирать здесь пока не из
            чего. Сначала добавьте API-ключ хотя бы одного провайдера в профиле.
          </p>
          <Link href="/profile" className="btn btn-primary btn-sm" style={{ marginTop: "0.6rem", display: "inline-block" }}>
            Перейти в профиль
          </Link>
        </div>
      ) : (
        <fieldset className="card" style={{ display: "flex", flexDirection: "column", gap: "0.7rem" }}>
          <legend className="provider-section-title">Выберите провайдера для этого проекта</legend>
          {OPTIONS.map((option) => {
            const available = option.requires.every((req) => configured[req]);
            const isActive = activeProvider === option.id;
            const missing = option.requires.filter((req) => !configured[req]);
            return (
              <label
                key={option.id}
                className={`model-option${isActive ? " model-option-active" : ""}${!available ? " model-option-unavailable" : ""}`}
              >
                <input
                  type="radio"
                  name="active-provider"
                  value={option.id}
                  checked={isActive}
                  disabled={!available || saving !== null}
                  onChange={() => handleSelect(option.id)}
                />
                <div className="model-option-main">
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                    <span>{option.label}</span>
                    {isActive ? <span className="badge badge-success">активна</span> : null}
                    {!available ? <span className="badge badge-neutral">не настроен</span> : null}
                    {saving === option.id ? <span className="spinner" aria-hidden="true" /> : null}
                  </div>
                  {!available ? (
                    <p className="field-hint" style={{ marginTop: "0.3rem" }}>
                      Не хватает ключа: {missing.join(", ")}. Добавьте{" "}
                      <Link href="/profile" style={{ textDecoration: "underline" }}>
                        в профиле
                      </Link>
                      .
                    </p>
                  ) : null}
                </div>
              </label>
            );
          })}
          {saveError ? (
            <div className="alert alert-danger" role="alert">
              {saveError}
            </div>
          ) : null}
        </fieldset>
      )}
    </div>
  );
}

function ModelPickerSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }} aria-busy="true" aria-label="Загрузка настроек модели">
      {[0, 1].map((i) => (
        <div key={i} className="card" style={{ height: "6rem" }}>
          <div className="skeleton" style={{ height: "100%", width: "100%" }} />
        </div>
      ))}
    </div>
  );
}
