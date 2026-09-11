"use client";

// components/projects/ModelPicker.tsx
//
// A project's two AI settings, via GET/PUT /api/projects/{projectId}/model:
//   - the chat model (active_ai_provider): switchable at any time;
//   - the embedding model (embedding_provider): picked once, fixed once the
//     project has documents (their vectors only compare with the same model).
// Options whose key isn't connected at the account level render disabled,
// with a link to /profile. Server errors (e.g. a key deleted in another tab)
// are shown inline using the server's own message.

import { useEffect, useState } from "react";
import Link from "next/link";
import { redirectToLogin } from "@/lib/ui/client-redirect";
import { getJson, putJson } from "@/components/sources/request-helpers";
import {
  EMBEDDING_PROVIDER_DISPLAY_INFO,
  EMBEDDING_PROVIDER_DISPLAY_ORDER,
  PROVIDER_DISPLAY_INFO,
  PROVIDER_DISPLAY_ORDER,
} from "@/lib/ui/provider-metadata";
// Type-only: a value import from "@/lib/ai" would pull server-only modules into this client bundle.
import type { ActiveAIProvider, AIProviderCredentialType, EmbeddingProviderType } from "@/lib/ai";

type ConfiguredFlags = Record<AIProviderCredentialType, boolean>;

interface ModelState {
  activeProvider: ActiveAIProvider | null;
  embeddingProvider: EmbeddingProviderType | null;
  embeddingLocked: boolean;
  configured: ConfiguredFlags;
}

type LoadState = { status: "loading" } | { status: "error"; message: string } | ({ status: "ready" } & ModelState);

async function fetchModelState(projectId: string): Promise<LoadState> {
  const result = await getJson<ModelState>(`/api/projects/${projectId}/model`);
  if (!result.ok) {
    if (result.kind === "unauthorized") {
      redirectToLogin();
      return { status: "loading" };
    }
    if (result.kind === "not_found") {
      return { status: "error", message: "Проект не найден — возможно, он был удалён в другой вкладке." };
    }
    return { status: "error", message: result.message };
  }
  return { status: "ready", ...result.data };
}

export function ModelPicker({ projectId }: { projectId: string }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [saving, setSaving] = useState<string | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [embeddingError, setEmbeddingError] = useState<string | null>(null);

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

  const { activeProvider, embeddingProvider, embeddingLocked, configured } = state;
  const nothingConfiguredAtAll = Object.values(configured).every((isConfigured) => !isConfigured);

  async function save(
    body: Record<string, string>,
    savingKey: string,
    setError: (message: string | null) => void,
    patch: Partial<ModelState>
  ) {
    setSaving(savingKey);
    setError(null);
    const result = await putJson<unknown>(`/api/projects/${projectId}/model`, body);
    setSaving(null);
    if (!result.ok) {
      if (result.kind === "unauthorized") {
        redirectToLogin();
        return;
      }
      setError(result.message);
      return;
    }
    setState((prev) => (prev.status === "ready" ? { ...prev, ...patch } : prev));
  }

  function handleSelectChat(provider: ActiveAIProvider) {
    if (provider === activeProvider || saving) return;
    void save({ provider }, `chat:${provider}`, setChatError, { activeProvider: provider });
  }

  function handleSelectEmbedding(provider: EmbeddingProviderType) {
    if (provider === embeddingProvider || saving || embeddingLocked) return;
    void save({ embeddingProvider: provider }, `embedding:${provider}`, setEmbeddingError, {
      embeddingProvider: provider,
    });
  }

  const embeddingInfo = embeddingProvider ? EMBEDDING_PROVIDER_DISPLAY_INFO[embeddingProvider] : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <section className="card">
        <h1 style={{ fontSize: "1.05rem", marginBottom: "0.4rem" }}>Модели проекта</h1>
        <p className="field-hint">
          Чат: <strong>{activeProvider ? PROVIDER_DISPLAY_INFO[activeProvider].label : "не выбрана"}</strong> ·
          Эмбеддинги:{" "}
          <strong>{embeddingInfo ? `${embeddingInfo.label} (${embeddingInfo.model})` : "не выбрана"}</strong>
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
        <>
          <fieldset className="card" style={{ display: "flex", flexDirection: "column", gap: "0.7rem" }}>
            <legend className="provider-section-title">Модель чата</legend>
            <p className="field-hint">
              Отвечает на вопросы. Её можно менять в любой момент — документы переиндексировать не нужно.
            </p>
            {PROVIDER_DISPLAY_ORDER.map((providerId) => (
              <ProviderOption
                key={providerId}
                name="chat-provider"
                label={PROVIDER_DISPLAY_INFO[providerId].label}
                missingKey={providerId}
                active={activeProvider === providerId}
                available={configured[providerId]}
                disabled={saving !== null}
                saving={saving === `chat:${providerId}`}
                onSelect={() => handleSelectChat(providerId)}
              />
            ))}
            {chatError ? (
              <div className="alert alert-danger" role="alert">
                {chatError}
              </div>
            ) : null}
          </fieldset>

          <fieldset className="card" style={{ display: "flex", flexDirection: "column", gap: "0.7rem" }}>
            <legend className="provider-section-title">Модель эмбеддингов (поиск по документам)</legend>
            <p className="field-hint">
              {embeddingLocked
                ? "Зафиксирована: документы проекта уже проиндексированы этой моделью, а векторы разных моделей несовместимы. Чтобы сменить её, удалите документы или создайте новый проект."
                : "Превращает документы и вопросы в векторы для поиска. Выбирается один раз: после добавления первого документа сменить её будет нельзя."}
            </p>
            {EMBEDDING_PROVIDER_DISPLAY_ORDER.map((providerId) => {
              const info = EMBEDDING_PROVIDER_DISPLAY_INFO[providerId];
              const active = embeddingProvider === providerId;
              return (
                <ProviderOption
                  key={providerId}
                  name="embedding-provider"
                  label={`${info.label} — ${info.model}`}
                  missingKey={providerId}
                  active={active}
                  available={configured[providerId]}
                  disabled={saving !== null || (embeddingLocked && !active)}
                  saving={saving === `embedding:${providerId}`}
                  onSelect={() => handleSelectEmbedding(providerId)}
                />
              );
            })}
            {embeddingError ? (
              <div className="alert alert-danger" role="alert">
                {embeddingError}
              </div>
            ) : null}
          </fieldset>
        </>
      )}
    </div>
  );
}

function ProviderOption({
  name,
  label,
  missingKey,
  active,
  available,
  disabled,
  saving,
  onSelect,
}: {
  name: string;
  label: string;
  missingKey: string;
  active: boolean;
  available: boolean;
  disabled: boolean;
  saving: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={`model-option${active ? " model-option-active" : ""}${!available ? " model-option-unavailable" : ""}`}
    >
      <input type="radio" name={name} checked={active} disabled={!available || disabled} onChange={onSelect} />
      <div className="model-option-main">
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <span>{label}</span>
          {active ? <span className="badge badge-success">активна</span> : null}
          {!available ? <span className="badge badge-neutral">не настроен</span> : null}
          {saving ? <span className="spinner" aria-hidden="true" /> : null}
        </div>
        {!available ? (
          <p className="field-hint" style={{ marginTop: "0.3rem" }}>
            Не хватает ключа: {missingKey}. Добавьте{" "}
            <Link href="/profile" style={{ textDecoration: "underline" }}>
              в профиле
            </Link>
            .
          </p>
        ) : null}
      </div>
    </label>
  );
}

function ModelPickerSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }} aria-busy="true" aria-label="Загрузка настроек модели">
      {[0, 1, 2].map((i) => (
        <div key={i} className="card" style={{ height: "6rem" }}>
          <div className="skeleton" style={{ height: "100%", width: "100%" }} />
        </div>
      ))}
    </div>
  );
}
