// lib/ui/model-catalog.ts
//
// Pure display logic for a project's model settings
// (components/projects/ModelPicker.tsx): which providers and models to
// offer in each slot, how to describe a model's specs and prices, and what
// to say when saving a choice fails. Operates on the catalog rows that
// GET /api/projects/{id}/model returns; type-only imports from "@/lib/ai".

import type { AIModelDTO, AIModelKind, AIProviderCredentialType } from "@/lib/ai";
import { PROVIDER_LABELS, joinProviderLabels, providerLabel, providersForKind, type ConfiguredProviders } from "./provider-metadata";

export type CatalogModel = AIModelDTO;

export function findModel(models: readonly CatalogModel[], id: string | null): CatalogModel | null {
  if (!id) return null;
  return models.find((model) => model.id === id) ?? null;
}

/**
 * Models of one provider offered in a slot: active ones plus the selected
 * one even if retired (it keeps working, but can't be re-picked once left).
 * Recommended first, then catalog order, a retired selection last.
 */
export function modelsForProvider(
  models: readonly CatalogModel[],
  kind: AIModelKind,
  provider: AIProviderCredentialType,
  selectedModelId: string | null
): CatalogModel[] {
  const rank = (model: CatalogModel) => (!model.isActive ? 2 : model.isRecommended ? 0 : 1);
  return models
    .filter((model) => model.kind === kind && model.provider === provider && (model.isActive || model.id === selectedModelId))
    .sort((a, b) => rank(a) - rank(b));
}

/** The model a provider switch saves: its recommended active model, else its first active one. */
export function defaultModelForProvider(
  models: readonly CatalogModel[],
  kind: AIModelKind,
  provider: AIProviderCredentialType
): CatalogModel | null {
  const candidates = models.filter((model) => model.kind === kind && model.provider === provider && model.isActive);
  return candidates.find((model) => model.isRecommended) ?? candidates[0] ?? null;
}

export interface ProviderChoice {
  provider: AIProviderCredentialType;
  label: string;
  hasKey: boolean;
  /** Has an active model of this kind to switch to. */
  hasModels: boolean;
  selected: boolean;
  disabled: boolean;
}

export interface SlotView {
  kind: AIModelKind;
  selectedModel: CatalogModel | null;
  providers: ProviderChoice[];
  /** The selected provider's models; empty until a model is chosen. */
  models: CatalogModel[];
  /** Model radios are unusable: the slot is locked or the selected provider's key is gone. */
  modelsDisabled: boolean;
  /** No saved key covers this kind at all. */
  noUsableProvider: boolean;
  /** The selected model's provider no longer has a saved key. */
  missingKeyProvider: AIProviderCredentialType | null;
  /** Pricing date shared by every listed model, or null when they differ (then each model shows its own). */
  commonPricingAsOf: string | null;
}

export interface SlotViewInput {
  kind: AIModelKind;
  models: readonly CatalogModel[];
  selectedModelId: string | null;
  configured: ConfiguredProviders;
  locked: boolean;
}

export function buildSlotView({ kind, models, selectedModelId, configured, locked }: SlotViewInput): SlotView {
  // A selected id outside this slot's kind would be a server bug; treat it as "nothing chosen".
  const found = findModel(models, selectedModelId);
  const selectedModel = found && found.kind === kind ? found : null;
  const providers = providersForKind(kind).map((provider): ProviderChoice => {
    const hasKey = configured[provider];
    const hasModels = defaultModelForProvider(models, kind, provider) !== null;
    return {
      provider,
      label: PROVIDER_LABELS[provider],
      hasKey,
      hasModels,
      selected: selectedModel?.provider === provider,
      disabled: locked || !hasKey || !hasModels,
    };
  });
  const listed = selectedModel ? modelsForProvider(models, kind, selectedModel.provider, selectedModel.id) : [];
  const missingKeyProvider = selectedModel && !configured[selectedModel.provider] ? selectedModel.provider : null;
  return {
    kind,
    selectedModel,
    providers,
    models: listed,
    modelsDisabled: locked || missingKeyProvider !== null,
    noUsableProvider: !providers.some((choice) => choice.hasKey),
    missingKeyProvider,
    commonPricingAsOf: commonPricingDate(listed),
  };
}

export function commonPricingDate(models: readonly CatalogModel[]): string | null {
  if (models.length === 0) return null;
  const first = models[0].pricingAsOf;
  return models.every((model) => model.pricingAsOf === first) ? first : null;
}

/** Russian plural form for `n`: [one, few, many] -- "1 токен", "2 токена", "5 токенов". */
export function pluralRu(n: number, forms: readonly [one: string, few: string, many: string]): string {
  const category = new Intl.PluralRules("ru-RU").select(n);
  if (category === "one") return forms[0];
  // "other" is fractions ("1,5 токена"), which take the "few" form.
  if (category === "few" || category === "other") return forms[1];
  return forms[2];
}

function formatNumber(value: number, maximumFractionDigits: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits }).format(value);
}

/** "1,05 млн токенов", "65,5 тыс. токенов", "8 191 токен". */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${formatNumber(tokens / 1_000_000, 2)} млн токенов`;
  if (tokens >= 10_000) return `${formatNumber(tokens / 1000, 1)} тыс. токенов`;
  return `${formatNumber(tokens, 0)} ${pluralRu(tokens, ["токен", "токена", "токенов"])}`;
}

/** "0,02 $" -- up to 4 decimals, since embedding prices are fractions of a cent per 1K. */
export function formatUsd(amount: number): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(amount);
}

/** "2026-09-11" -> "11.09.2026"; parsed by hand so the date never shifts with the viewer's time zone. */
export function formatPricingDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : isoDate;
}

/** "1536 измерений", "1024 измерения". */
export function formatDimensions(dimensions: number): string {
  return `${dimensions} ${pluralRu(dimensions, ["измерение", "измерения", "измерений"])}`;
}

/** Price per 1M tokens: "вход 0,20 $ · выход 1,20 $" for chat, "0,02 $" for embeddings. */
export function formatModelPrice(model: CatalogModel): string {
  if (model.kind === "embedding") return formatUsd(model.inputPriceUsdPerMtok);
  const input = `вход ${formatUsd(model.inputPriceUsdPerMtok)}`;
  return model.outputPriceUsdPerMtok === null ? input : `${input} · выход ${formatUsd(model.outputPriceUsdPerMtok)}`;
}

export interface ModelSpec {
  label: string;
  value: string;
}

/** The facts shown under a model's name; the pricing date is appended when the section can't show one shared date. */
export function modelSpecs(model: CatalogModel, options: { showPricingDate: boolean }): ModelSpec[] {
  const price = formatModelPrice(model) + (options.showPricingDate ? ` (на ${formatPricingDate(model.pricingAsOf)})` : "");
  const specs: ModelSpec[] = [];
  if (model.kind === "embedding" && model.dimensions !== null) {
    specs.push({ label: "Размерность вектора", value: formatDimensions(model.dimensions) });
  }
  specs.push({ label: "Контекст", value: formatTokenCount(model.contextWindow) });
  if (model.kind === "chat" && model.maxOutputTokens !== null) {
    specs.push({ label: "Макс. ответ", value: formatTokenCount(model.maxOutputTokens) });
  }
  specs.push({ label: "Цена за 1 млн токенов", value: price });
  return specs;
}

/** One-line summary of a slot's choice: "GPT-5.6 Luna (OpenAI)", "Voyage 4 (Voyage AI, 1024 измерения)". */
export function describeSelection(model: CatalogModel | null): string {
  if (!model) return "не выбрана";
  const details = [providerLabel(model.provider)];
  if (model.kind === "embedding" && model.dimensions !== null) details.push(formatDimensions(model.dimensions));
  return `${model.displayName} (${details.join(", ")})`;
}

/** Hint for a slot none of the saved keys can serve. */
export function missingKindKeyHint(kind: AIModelKind): string {
  const providers = joinProviderLabels(providersForKind(kind));
  return kind === "chat"
    ? `Для модели чата нужен ключ ${providers}.`
    : `Для поиска по документам нужен ключ ${providers}.`;
}

export interface ModelSaveError {
  message: string;
  /** What the error banner offers: a link to /profile, or reloading the settings. */
  action: "profile" | "reload" | null;
  /** The server says the embedding slot is locked (documents were added meanwhile). */
  lockSlot: boolean;
  /** The server says this provider has no saved key (e.g. deleted in another tab). */
  missingKeyProvider: AIProviderCredentialType | null;
}

function stringField(body: unknown, field: string): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function isProvider(value: string | undefined): value is AIProviderCredentialType {
  return value !== undefined && value in PROVIDER_LABELS;
}

/**
 * Maps a failed PUT /api/projects/{id}/model to what the picker shows.
 * `status` 0 means the request never reached the server; 401 is handled by
 * the caller (redirect to login) before this is consulted.
 */
export function describeModelSaveError(status: number, body: unknown, kind: AIModelKind): ModelSaveError {
  const result = (message: string, action: ModelSaveError["action"] = null): ModelSaveError => ({
    message,
    action,
    lockSlot: false,
    missingKeyProvider: null,
  });
  const error = stringField(body, "error");

  if (status === 0) return result("Не удалось подключиться к серверу. Проверьте соединение и попробуйте ещё раз.");
  if (status === 404) return result("Проект не найден — возможно, он был удалён в другой вкладке.");
  if (status === 429) {
    return result(stringField(body, "message") ?? "Слишком много запросов. Подождите немного и попробуйте снова.");
  }

  if (status === 400 && error === "invalid_model") {
    switch (stringField(body, "reason")) {
      case "not_found":
        return result("Этой модели больше нет в каталоге. Обновите список моделей.", "reload");
      case "wrong_kind":
        return result(
          kind === "chat" ? "Эта модель не подходит для чата. Выберите модель из списка." : "Эта модель не подходит для эмбеддингов. Выберите модель из списка.",
          "reload"
        );
      case "inactive":
        return result("Эта модель снята с поддержки и больше недоступна для выбора. Выберите другую.", "reload");
      default:
        return result("Эту модель нельзя выбрать. Обновите список моделей.", "reload");
    }
  }
  if (status === 400) return result("Не удалось сохранить выбор: сервер отклонил запрос. Обновите страницу и попробуйте снова.", "reload");

  if (status === 409 && error === "embedding_locked") {
    return {
      ...result(
        "Модель эмбеддингов уже нельзя сменить: в проекте появились документы, проиндексированные текущей моделью. Смена потребует переиндексировать все документы, а это пока недоступно."
      ),
      lockSlot: true,
    };
  }

  if (status === 422 && error === "missing_credentials") {
    const provider = stringField(body, "provider");
    const known = isProvider(provider) ? provider : null;
    const label = known ? PROVIDER_LABELS[known] : "этого провайдера";
    return {
      ...result(`Для этой модели нужен API-ключ ${label}, а он не сохранён в профиле. Добавьте ключ и вернитесь сюда.`, "profile"),
      missingKeyProvider: known,
    };
  }

  return result("Не удалось сохранить выбор модели. Попробуйте ещё раз чуть позже.");
}
