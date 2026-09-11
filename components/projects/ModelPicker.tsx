"use client";

// components/projects/ModelPicker.tsx
//
// A project's two catalog models, via GET/PUT /api/projects/{projectId}/model:
//   - the chat model: switchable at any time;
//   - the embedding model: fixed once the project has documents, because
//     their vectors were built by it.
// In each slot the user picks a provider (only those with a saved key),
// which immediately saves that provider's recommended model, then may pick
// another model of the same provider. Display/derivation logic lives in
// lib/ui/model-catalog.ts.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { redirectToLogin } from "@/lib/ui/client-redirect";
import { getJson } from "@/components/sources/request-helpers";
import { PROVIDER_LABELS, type ConfiguredProviders } from "@/lib/ui/provider-metadata";
import {
  buildSlotView,
  defaultModelForProvider,
  describeModelSaveError,
  describeSelection,
  findModel,
  formatDimensions,
  formatPricingDate,
  missingKindKeyHint,
  modelSpecs,
  type CatalogModel,
  type ModelSaveError,
  type ProviderChoice,
  type SlotView,
} from "@/lib/ui/model-catalog";
// Type-only: a value import from "@/lib/ai" would pull server-only modules into this client bundle.
import type { AIModelKind, AIProviderCredentialType } from "@/lib/ai";

interface ModelSettings {
  chatModelId: string | null;
  embeddingModelId: string | null;
  embeddingLocked: boolean;
  configured: ConfiguredProviders;
  models: CatalogModel[];
}

type LoadState = { status: "loading" } | { status: "error"; message: string } | ({ status: "ready" } & ModelSettings);

type PutResult = { ok: true } | { ok: false; status: number; body: unknown };

const SLOT_TITLES: Record<AIModelKind, string> = {
  chat: "Модель чата",
  embedding: "Модель эмбеддингов (поиск по документам)",
};

async function fetchModelSettings(projectId: string): Promise<LoadState> {
  const result = await getJson<ModelSettings>(`/api/projects/${projectId}/model`);
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

// Own fetch rather than request-helpers: the error mapping needs the raw
// status and body fields (reason, provider) that normalizeResponse() drops.
async function putModel(projectId: string, body: { chatModelId: string } | { embeddingModelId: string }): Promise<PutResult> {
  try {
    const response = await fetch(`/api/projects/${projectId}/model`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) return { ok: true };
    return { ok: false, status: response.status, body: await response.json().catch(() => null) };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

export function ModelPicker({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [savingModelId, setSavingModelId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<AIModelKind, ModelSaveError | null>>({ chat: null, embedding: null });
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchModelSettings(projectId).then((result) => {
      if (!cancelled) setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  function reload() {
    setState({ status: "loading" });
    setErrors({ chat: null, embedding: null });
    setSavedNotice(null);
    void fetchModelSettings(projectId).then((result) => setState(result));
  }

  if (state.status === "loading") {
    return <ModelPickerSkeleton />;
  }

  if (state.status === "error") {
    return (
      <div className="card empty-state" role="alert">
        <p>{state.message}</p>
        <div>
          <button type="button" className="btn btn-secondary" onClick={reload}>
            Попробовать снова
          </button>
        </div>
      </div>
    );
  }

  const { models, configured } = state;
  const chatView = buildSlotView({
    kind: "chat",
    models,
    selectedModelId: state.chatModelId,
    configured,
    locked: false,
  });
  const embeddingView = buildSlotView({
    kind: "embedding",
    models,
    selectedModelId: state.embeddingModelId,
    configured,
    locked: state.embeddingLocked,
  });
  const noKeysAtAll = Object.values(configured).every((isConfigured) => !isConfigured);

  async function saveModel(kind: AIModelKind, model: CatalogModel) {
    if (savingModelId !== null || state.status !== "ready") return;
    const currentId = kind === "chat" ? state.chatModelId : state.embeddingModelId;
    if (model.id === currentId) return;

    setSavingModelId(model.id);
    setErrors((prev) => ({ ...prev, [kind]: null }));
    setSavedNotice(null);
    const result = await putModel(projectId, kind === "chat" ? { chatModelId: model.id } : { embeddingModelId: model.id });
    setSavingModelId(null);

    if (result.ok) {
      setState((prev) =>
        prev.status === "ready"
          ? { ...prev, ...(kind === "chat" ? { chatModelId: model.id } : { embeddingModelId: model.id }) }
          : prev
      );
      setSavedNotice(`${SLOT_TITLES[kind]}: ${model.displayName} — сохранено.`);
      // The project header's "Работает на: …" badge is server-rendered.
      if (kind === "chat") router.refresh();
      return;
    }
    if (result.status === 401) {
      redirectToLogin();
      return;
    }
    const error = describeModelSaveError(result.status, result.body, kind);
    setErrors((prev) => ({ ...prev, [kind]: error }));
    const missingKeyProvider = error.missingKeyProvider;
    if (error.lockSlot || missingKeyProvider) {
      setState((prev) => {
        if (prev.status !== "ready") return prev;
        return {
          ...prev,
          embeddingLocked: prev.embeddingLocked || error.lockSlot,
          configured: missingKeyProvider ? { ...prev.configured, [missingKeyProvider]: false } : prev.configured,
        };
      });
    }
  }

  function selectProvider(kind: AIModelKind, provider: AIProviderCredentialType) {
    const target = defaultModelForProvider(models, kind, provider);
    if (target) void saveModel(kind, target);
  }

  const savingModel = findModel(models, savingModelId);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <section className="card" aria-labelledby="model-settings-heading">
        <h2 id="model-settings-heading" style={{ fontSize: "1.05rem", marginBottom: "0.4rem" }}>
          Модели проекта
        </h2>
        <p className="field-hint">
          Модель чата отвечает на вопросы, модель эмбеддингов превращает документы и вопросы в векторы
          для поиска. Доступны модели тех провайдеров, чьи API-ключи сохранены в{" "}
          <Link href="/profile" style={{ textDecoration: "underline" }}>
            профиле
          </Link>
          .
        </p>
        <dl className="model-specs" style={{ marginTop: "0.6rem", fontSize: "0.85rem" }}>
          <div>
            <dt className="model-spec-label" style={{ display: "inline" }}>
              Чат:{" "}
            </dt>
            <dd style={{ display: "inline", margin: 0 }}>
              <strong>{describeSelection(chatView.selectedModel)}</strong>
            </dd>
          </div>
          <div>
            <dt className="model-spec-label" style={{ display: "inline" }}>
              Эмбеддинги:{" "}
            </dt>
            <dd style={{ display: "inline", margin: 0 }}>
              <strong>{describeSelection(embeddingView.selectedModel)}</strong>
            </dd>
          </div>
        </dl>
      </section>

      {noKeysAtAll ? (
        <div className="alert alert-warning" role="status">
          <p style={{ margin: 0 }}>
            К аккаунту пока не подключён ни один AI-провайдер, поэтому выбрать модель нельзя. Добавьте API-ключ
            в профиле: ключа OpenAI или Gemini хватит и на чат, и на поиск по документам.
          </p>
          <Link href="/profile" className="btn btn-primary btn-sm" style={{ marginTop: "0.6rem", display: "inline-block" }}>
            Перейти в профиль
          </Link>
        </div>
      ) : null}

      <p role="status" className="visually-hidden">
        {savedNotice ?? ""}
      </p>

      <ModelSlotSection
        view={chatView}
        intro="Отвечает на вопросы по найденным фрагментам документов. Её можно менять в любой момент — документы переиндексировать не нужно."
        savingModel={savingModel}
        error={errors.chat}
        onSelectProvider={(provider) => selectProvider("chat", provider)}
        onSelectModel={(model) => void saveModel("chat", model)}
        onReload={reload}
      />

      <ModelSlotSection
        view={embeddingView}
        intro={
          state.embeddingLocked
            ? "Превращает документы и вопросы в векторы для поиска."
            : "Превращает документы и вопросы в векторы для поиска. Пока в проекте нет документов, модель можно менять свободно; после добавления первого документа она фиксируется."
        }
        savingModel={savingModel}
        error={errors.embedding}
        onSelectProvider={(provider) => selectProvider("embedding", provider)}
        onSelectModel={(model) => void saveModel("embedding", model)}
        onReload={reload}
        locked={state.embeddingLocked}
      />
    </div>
  );
}

function ModelSlotSection({
  view,
  intro,
  savingModel,
  error,
  onSelectProvider,
  onSelectModel,
  onReload,
  locked = false,
}: {
  view: SlotView;
  intro: string;
  savingModel: CatalogModel | null;
  error: ModelSaveError | null;
  onSelectProvider: (provider: AIProviderCredentialType) => void;
  onSelectModel: (model: CatalogModel) => void;
  onReload: () => void;
  locked?: boolean;
}) {
  const { kind, selectedModel } = view;
  const busy = savingModel !== null;
  const selectedProviderLabel = selectedModel ? PROVIDER_LABELS[selectedModel.provider] : null;

  return (
    <fieldset className="card model-slot" aria-busy={busy && savingModel?.kind === kind}>
      <legend className="provider-section-title">{SLOT_TITLES[kind]}</legend>
      <p className="field-hint">{intro}</p>

      {locked && selectedModel ? (
        <div className="alert alert-warning" role="note">
          <strong>Модель эмбеддингов зафиксирована.</strong> Векторы документов этого проекта построены моделью{" "}
          «{selectedModel.displayName}»
          {selectedModel.dimensions !== null ? ` (${formatDimensions(selectedModel.dimensions)})` : ""}, а векторы
          разных моделей несовместимы. Смена модели потребует переиндексировать все документы проекта — это пока
          недоступно. Модель чата можно менять свободно.
        </div>
      ) : null}

      {view.missingKeyProvider ? (
        <div className="alert alert-danger" role="alert">
          <p style={{ margin: 0 }}>
            Ключ {PROVIDER_LABELS[view.missingKeyProvider]} удалён из профиля: выбранная модель не будет работать,
            пока вы не добавите его снова.
          </p>
          <Link href="/profile" className="btn btn-primary btn-sm" style={{ marginTop: "0.6rem", display: "inline-block" }}>
            Добавить ключ в профиле
          </Link>
        </div>
      ) : null}

      {view.noUsableProvider ? (
        <p className="alert alert-info">
          {missingKindKeyHint(kind)}{" "}
          <Link href="/profile" style={{ textDecoration: "underline" }}>
            Добавить ключ в профиле
          </Link>
        </p>
      ) : null}

      <fieldset className="model-subgroup">
        <legend className="model-subgroup-title">Провайдер</legend>
        <div className="provider-choice-grid">
          {view.providers.map((choice) => (
            <ProviderChoiceOption
              key={choice.provider}
              kind={kind}
              choice={choice}
              busy={busy}
              saving={savingModel !== null && savingModel.kind === kind && savingModel.provider === choice.provider && !choice.selected}
              onSelect={() => onSelectProvider(choice.provider)}
            />
          ))}
        </div>
      </fieldset>

      {selectedModel ? (
        <fieldset className="model-subgroup">
          <legend className="model-subgroup-title">Модель {selectedProviderLabel}</legend>
          {view.commonPricingAsOf ? (
            <p className="field-hint">
              Цены в долларах США за 1 млн токенов, по данным на {formatPricingDate(view.commonPricingAsOf)}.
            </p>
          ) : null}
          <div className="model-option-list">
            {view.models.map((model) => (
              <ModelChoiceOption
                key={model.id}
                model={model}
                checked={model.id === selectedModel.id}
                disabled={view.modelsDisabled || busy}
                saving={savingModel?.id === model.id}
                showPricingDate={view.commonPricingAsOf === null}
                onSelect={() => onSelectModel(model)}
              />
            ))}
          </div>
        </fieldset>
      ) : !view.noUsableProvider ? (
        <p className="field-hint">
          Выберите провайдера — сразу сохранится его рекомендуемая модель, её можно будет поменять на другую.
        </p>
      ) : null}

      {error ? (
        <div className="alert alert-danger" role="alert">
          <p style={{ margin: 0 }}>{error.message}</p>
          {error.action === "profile" ? (
            <Link href="/profile" className="btn btn-primary btn-sm" style={{ marginTop: "0.6rem", display: "inline-block" }}>
              Перейти в профиль
            </Link>
          ) : null}
          {error.action === "reload" ? (
            <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: "0.6rem" }} onClick={onReload}>
              Обновить список моделей
            </button>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}

function ProviderChoiceOption({
  kind,
  choice,
  busy,
  saving,
  onSelect,
}: {
  kind: AIModelKind;
  choice: ProviderChoice;
  busy: boolean;
  saving: boolean;
  onSelect: () => void;
}) {
  const inputId = `${kind}-provider-${choice.provider}`;
  const hintId = `${inputId}-hint`;
  const hint = !choice.hasKey ? "нет ключа" : !choice.hasModels ? "нет доступных моделей" : null;
  const className = `model-option${choice.selected ? " model-option-active" : ""}${choice.disabled && !choice.selected ? " model-option-unavailable" : ""}`;

  return (
    <div className={className}>
      <input
        type="radio"
        id={inputId}
        name={`${kind}-provider`}
        checked={choice.selected}
        disabled={choice.disabled || busy}
        onChange={onSelect}
        aria-describedby={hint ? hintId : undefined}
      />
      <div className="model-option-main">
        <div className="model-option-title">
          <label htmlFor={inputId} className="model-option-label">
            {choice.label}
          </label>
          {saving ? <span className="spinner" aria-hidden="true" /> : null}
        </div>
        {hint ? (
          <p id={hintId} className="field-hint">
            {choice.hasKey ? (
              hint
            ) : (
              <>
                Нет ключа —{" "}
                <Link href="/profile" style={{ textDecoration: "underline" }}>
                  добавить в профиле
                </Link>
              </>
            )}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ModelChoiceOption({
  model,
  checked,
  disabled,
  saving,
  showPricingDate,
  onSelect,
}: {
  model: CatalogModel;
  checked: boolean;
  disabled: boolean;
  saving: boolean;
  showPricingDate: boolean;
  onSelect: () => void;
}) {
  const inputId = `${model.kind}-model-${model.id}`;
  const specsId = `${inputId}-specs`;
  const specs = modelSpecs(model, { showPricingDate });
  const className = `model-option${checked ? " model-option-active" : ""}${disabled && !checked ? " model-option-unavailable" : ""}`;

  return (
    <div className={className}>
      <input
        type="radio"
        id={inputId}
        name={`${model.kind}-model`}
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
        aria-describedby={specsId}
      />
      <div className="model-option-main">
        <div className="model-option-title">
          <label htmlFor={inputId} className="model-option-label">
            {model.displayName}
          </label>
          {model.isRecommended ? <span className="badge badge-accent">рекомендуемая</span> : null}
          {checked ? <span className="badge badge-success">выбрана</span> : null}
          {!model.isActive ? <span className="badge badge-warning">снята с поддержки</span> : null}
          {saving ? <span className="spinner" aria-hidden="true" /> : null}
        </div>
        <div id={specsId} style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          <code className="model-option-id">{model.modelId}</code>
          <ul className="model-specs">
            {specs.map((spec) => (
              <li key={spec.label}>
                <span className="model-spec-label">{spec.label}:</span> {spec.value}
              </li>
            ))}
          </ul>
          {!model.isActive ? (
            <p className="field-hint">
              Модель продолжает работать, но если выбрать другую, вернуться к ней будет нельзя.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ModelPickerSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }} aria-busy="true" aria-label="Загрузка настроек модели">
      {["6rem", "14rem", "14rem"].map((height, i) => (
        <div key={i} className="card" style={{ height }}>
          <div className="skeleton" style={{ height: "100%", width: "100%" }} />
        </div>
      ))}
    </div>
  );
}
