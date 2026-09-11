import { describe, expect, it } from "vitest";
import {
  buildSlotView,
  commonPricingDate,
  defaultModelForProvider,
  describeModelSaveError,
  describeSelection,
  formatDimensions,
  formatModelPrice,
  formatPricingDate,
  formatTokenCount,
  formatUsd,
  missingKindKeyHint,
  modelSpecs,
  modelsForProvider,
  pluralRu,
  type CatalogModel,
} from "../model-catalog";
import type { ConfiguredProviders } from "../provider-metadata";

// Intl uses no-break spaces (U+00A0 / U+202F) as separators; compare with plain spaces.
const plain = (text: string) => text.replace(/[\u00a0\u202f]/g, " ");

function model(overrides: Partial<CatalogModel> & Pick<CatalogModel, "id" | "provider" | "kind">): CatalogModel {
  const chat = overrides.kind === "chat";
  return {
    modelId: overrides.id,
    displayName: overrides.id,
    dimensions: chat ? null : 1024,
    contextWindow: chat ? 1_000_000 : 8191,
    maxOutputTokens: chat ? 128_000 : null,
    inputPriceUsdPerMtok: chat ? 0.2 : 0.02,
    outputPriceUsdPerMtok: chat ? 1.2 : null,
    pricingAsOf: "2026-09-11",
    isRecommended: false,
    isActive: true,
    ...overrides,
  };
}

// In catalog (sort_order) order, as the API returns it.
const CATALOG: CatalogModel[] = [
  model({ id: "oa-terra", provider: "openai", kind: "chat", displayName: "GPT-5.6 Terra" }),
  model({ id: "oa-luna", provider: "openai", kind: "chat", displayName: "GPT-5.6 Luna", isRecommended: true }),
  model({ id: "oa-old", provider: "openai", kind: "chat", isActive: false }),
  model({ id: "oa-mini", provider: "openai", kind: "chat" }),
  model({ id: "an-opus", provider: "anthropic", kind: "chat", isRecommended: true }),
  model({ id: "ge-flash", provider: "gemini", kind: "chat", isRecommended: true }),
  model({ id: "oa-small", provider: "openai", kind: "embedding", displayName: "text-embedding-3-small", dimensions: 1536, isRecommended: true }),
  model({ id: "oa-large", provider: "openai", kind: "embedding", dimensions: 3072 }),
  model({ id: "ge-emb", provider: "gemini", kind: "embedding", dimensions: 3072, isActive: false }),
  model({ id: "vo-4", provider: "voyage", kind: "embedding", displayName: "Voyage 4" }),
  model({ id: "vo-lite", provider: "voyage", kind: "embedding" }),
];

const NONE: ConfiguredProviders = { openai: false, anthropic: false, gemini: false, voyage: false };
const ids = (models: CatalogModel[]) => models.map((m) => m.id);

describe("modelsForProvider", () => {
  it("keeps one provider's models of one kind, recommended first, then catalog order", () => {
    expect(ids(modelsForProvider(CATALOG, "chat", "openai", null))).toEqual(["oa-luna", "oa-terra", "oa-mini"]);
    expect(ids(modelsForProvider(CATALOG, "embedding", "openai", null))).toEqual(["oa-small", "oa-large"]);
  });

  it("hides retired models unless selected, and lists a retired selection last", () => {
    expect(ids(modelsForProvider(CATALOG, "chat", "openai", "oa-terra"))).not.toContain("oa-old");
    expect(ids(modelsForProvider(CATALOG, "chat", "openai", "oa-old"))).toEqual(["oa-luna", "oa-terra", "oa-mini", "oa-old"]);
  });
});

describe("defaultModelForProvider", () => {
  it("picks the provider's recommended model for that kind", () => {
    expect(defaultModelForProvider(CATALOG, "chat", "openai")?.id).toBe("oa-luna");
    expect(defaultModelForProvider(CATALOG, "embedding", "openai")?.id).toBe("oa-small");
  });

  it("falls back to the first active model when none is recommended", () => {
    expect(defaultModelForProvider(CATALOG, "embedding", "voyage")?.id).toBe("vo-4");
  });

  it("is null when the provider has only retired models, or none of that kind", () => {
    expect(defaultModelForProvider(CATALOG, "embedding", "gemini")).toBeNull();
    expect(defaultModelForProvider(CATALOG, "embedding", "anthropic")).toBeNull();
  });
});

describe("buildSlotView", () => {
  it("shows the selected model's provider and its models; providers without a key are disabled", () => {
    const view = buildSlotView({
      kind: "chat",
      models: CATALOG,
      selectedModelId: "oa-terra",
      configured: { ...NONE, openai: true },
      locked: false,
    });
    expect(view.selectedModel?.id).toBe("oa-terra");
    expect(view.providers).toEqual([
      { provider: "openai", label: "OpenAI", hasKey: true, hasModels: true, selected: true, disabled: false },
      { provider: "anthropic", label: "Anthropic Claude", hasKey: false, hasModels: true, selected: false, disabled: true },
      { provider: "gemini", label: "Google Gemini", hasKey: false, hasModels: true, selected: false, disabled: true },
    ]);
    expect(ids(view.models)).toEqual(["oa-luna", "oa-terra", "oa-mini"]);
    expect(view).toMatchObject({ modelsDisabled: false, noUsableProvider: false, missingKeyProvider: null, commonPricingAsOf: "2026-09-11" });
  });

  it("lists no models and selects no provider until a model is chosen", () => {
    const view = buildSlotView({
      kind: "chat",
      models: CATALOG,
      selectedModelId: null,
      configured: { ...NONE, openai: true, anthropic: true },
      locked: false,
    });
    expect(view.selectedModel).toBeNull();
    expect(view.models).toEqual([]);
    expect(view.providers.some((choice) => choice.selected)).toBe(false);
    expect(view.providers.filter((choice) => !choice.disabled).map((choice) => choice.provider)).toEqual(["openai", "anthropic"]);
  });

  it("disables every provider and model when the slot is locked", () => {
    const view = buildSlotView({
      kind: "embedding",
      models: CATALOG,
      selectedModelId: "oa-small",
      configured: { ...NONE, openai: true, voyage: true },
      locked: true,
    });
    expect(view.providers.every((choice) => choice.disabled)).toBe(true);
    expect(view.modelsDisabled).toBe(true);
    expect(view.providers.find((choice) => choice.selected)?.provider).toBe("openai");
  });

  it("flags a selected model whose provider's key was deleted", () => {
    const view = buildSlotView({
      kind: "embedding",
      models: CATALOG,
      selectedModelId: "oa-small",
      configured: { ...NONE, voyage: true },
      locked: false,
    });
    expect(view.missingKeyProvider).toBe("openai");
    expect(view.modelsDisabled).toBe(true);
    expect(view.providers.find((choice) => choice.provider === "voyage")?.disabled).toBe(false);
  });

  it("marks a provider with only retired models as having no models", () => {
    const view = buildSlotView({ kind: "embedding", models: CATALOG, selectedModelId: null, configured: { ...NONE, gemini: true }, locked: false });
    expect(view.providers.find((choice) => choice.provider === "gemini")).toMatchObject({ hasKey: true, hasModels: false, disabled: true });
  });

  it("reports when no saved key covers the slot's kind", () => {
    const configured = { ...NONE, anthropic: true };
    expect(buildSlotView({ kind: "embedding", models: CATALOG, selectedModelId: null, configured, locked: false }).noUsableProvider).toBe(true);
    expect(buildSlotView({ kind: "chat", models: CATALOG, selectedModelId: null, configured, locked: false }).noUsableProvider).toBe(false);
  });

  it("ignores a selected id of the other kind", () => {
    const view = buildSlotView({ kind: "chat", models: CATALOG, selectedModelId: "oa-small", configured: { ...NONE, openai: true }, locked: false });
    expect(view.selectedModel).toBeNull();
  });

  it("drops the shared pricing date when the listed models' dates differ", () => {
    const models = CATALOG.map((m) => (m.id === "oa-mini" ? { ...m, pricingAsOf: "2026-01-01" } : m));
    const view = buildSlotView({ kind: "chat", models, selectedModelId: "oa-luna", configured: { ...NONE, openai: true }, locked: false });
    expect(view.commonPricingAsOf).toBeNull();
  });
});

describe("commonPricingDate", () => {
  it("is the shared date, null for differing dates or no models", () => {
    expect(commonPricingDate(CATALOG.slice(0, 2))).toBe("2026-09-11");
    expect(commonPricingDate([CATALOG[0], { ...CATALOG[1], pricingAsOf: "2026-01-01" }])).toBeNull();
    expect(commonPricingDate([])).toBeNull();
  });
});

describe("pluralRu", () => {
  it("picks one/few/many forms, and the few form for fractions", () => {
    const forms = ["токен", "токена", "токенов"] as const;
    expect([1, 2, 5, 11, 21, 1.5].map((n) => pluralRu(n, forms))).toEqual(["токен", "токена", "токенов", "токенов", "токен", "токена"]);
  });
});

describe("formatTokenCount", () => {
  it("abbreviates millions and tens of thousands, keeps small counts exact", () => {
    expect(formatTokenCount(1_050_000)).toBe("1,05 млн токенов");
    expect(formatTokenCount(1_047_576)).toBe("1,05 млн токенов");
    expect(formatTokenCount(1_000_000)).toBe("1 млн токенов");
    expect(formatTokenCount(128_000)).toBe("128 тыс. токенов");
    expect(formatTokenCount(65_536)).toBe("65,5 тыс. токенов");
    expect(plain(formatTokenCount(8191))).toBe("8 191 токен");
    expect(plain(formatTokenCount(2048))).toBe("2 048 токенов");
  });
});

describe("formatUsd", () => {
  it("formats USD the Russian way with 2 to 4 decimals", () => {
    expect(plain(formatUsd(0.02))).toBe("0,02 $");
    expect(plain(formatUsd(12))).toBe("12,00 $");
    expect(plain(formatUsd(0.125))).toBe("0,125 $");
  });
});

describe("formatPricingDate", () => {
  it("turns YYYY-MM-DD into DD.MM.YYYY without time-zone shifts, and echoes anything else", () => {
    expect(formatPricingDate("2026-09-11")).toBe("11.09.2026");
    expect(formatPricingDate("2026-01-01")).toBe("01.01.2026");
    expect(formatPricingDate("soon")).toBe("soon");
  });
});

describe("formatDimensions", () => {
  it("adds the right plural form", () => {
    expect(formatDimensions(1536)).toBe("1536 измерений");
    expect(formatDimensions(1024)).toBe("1024 измерения");
    expect(formatDimensions(3072)).toBe("3072 измерения");
    expect(formatDimensions(256)).toBe("256 измерений");
  });
});

describe("formatModelPrice", () => {
  it("shows input and output prices for chat, only input for embeddings", () => {
    expect(plain(formatModelPrice(CATALOG[0]))).toBe("вход 0,20 $ · выход 1,20 $");
    expect(plain(formatModelPrice({ ...CATALOG[0], outputPriceUsdPerMtok: null }))).toBe("вход 0,20 $");
    expect(plain(formatModelPrice(CATALOG[6]))).toBe("0,02 $");
  });
});

describe("modelSpecs", () => {
  it("leads an embedding model with its vector dimension", () => {
    const specs = modelSpecs(CATALOG[6], { showPricingDate: false }).map((s) => ({ ...s, value: plain(s.value) }));
    expect(specs).toEqual([
      { label: "Размерность вектора", value: "1536 измерений" },
      { label: "Контекст", value: "8 191 токен" },
      { label: "Цена за 1 млн токенов", value: "0,02 $" },
    ]);
  });

  it("shows context, max output and both prices for a chat model", () => {
    const specs = modelSpecs(CATALOG[1], { showPricingDate: false }).map((s) => ({ ...s, value: plain(s.value) }));
    expect(specs).toEqual([
      { label: "Контекст", value: "1 млн токенов" },
      { label: "Макс. ответ", value: "128 тыс. токенов" },
      { label: "Цена за 1 млн токенов", value: "вход 0,20 $ · выход 1,20 $" },
    ]);
  });

  it("appends the pricing date when asked", () => {
    const price = modelSpecs(CATALOG[6], { showPricingDate: true }).at(-1);
    expect(plain(price?.value ?? "")).toBe("0,02 $ (на 11.09.2026)");
  });
});

describe("describeSelection", () => {
  it("names the model with its provider, plus the dimension for embeddings", () => {
    expect(describeSelection(null)).toBe("не выбрана");
    expect(describeSelection(CATALOG[1])).toBe("GPT-5.6 Luna (OpenAI)");
    expect(describeSelection(CATALOG[9])).toBe("Voyage 4 (Voyage AI, 1024 измерения)");
  });
});

describe("missingKindKeyHint", () => {
  it("lists the providers that can serve the kind", () => {
    expect(missingKindKeyHint("chat")).toBe("Для модели чата нужен ключ OpenAI, Anthropic Claude или Google Gemini.");
    expect(missingKindKeyHint("embedding")).toBe("Для поиска по документам нужен ключ OpenAI, Google Gemini или Voyage AI.");
  });
});

describe("describeModelSaveError", () => {
  it("offers a reload for every invalid_model reason", () => {
    for (const reason of ["not_found", "wrong_kind", "inactive", "something_new"]) {
      const error = describeModelSaveError(400, { error: "invalid_model", reason, message: "x" }, "chat");
      expect(error.action).toBe("reload");
      expect(error.message).not.toBe("x");
    }
    expect(describeModelSaveError(400, { error: "invalid_model", reason: "inactive" }, "chat").message).toContain("снята с поддержки");
    expect(describeModelSaveError(400, { error: "invalid_model", reason: "wrong_kind" }, "embedding").message).toContain("эмбеддингов");
  });

  it("treats a malformed request as a reload case", () => {
    expect(describeModelSaveError(400, { error: "invalid_request", details: {} }, "chat").action).toBe("reload");
  });

  it("locks the slot on embedding_locked and mentions re-indexing", () => {
    const error = describeModelSaveError(409, { error: "embedding_locked", message: "server text" }, "embedding");
    expect(error.lockSlot).toBe(true);
    expect(error.message).toContain("переиндексировать");
  });

  it("names the provider and links to the profile on missing_credentials", () => {
    const error = describeModelSaveError(422, { error: "missing_credentials", provider: "voyage", message: "x" }, "embedding");
    expect(error).toMatchObject({ action: "profile", missingKeyProvider: "voyage", lockSlot: false });
    expect(error.message).toContain("Voyage AI");
  });

  it("still links to the profile when the provider is unknown", () => {
    const error = describeModelSaveError(422, { error: "missing_credentials", provider: "mistral" }, "chat");
    expect(error).toMatchObject({ action: "profile", missingKeyProvider: null });
  });

  it("explains a vanished project, a network failure, a rate limit and a server error", () => {
    expect(describeModelSaveError(404, { error: "not_found" }, "chat").message).toContain("Проект не найден");
    expect(describeModelSaveError(0, null, "chat").message).toContain("подключиться к серверу");
    expect(describeModelSaveError(429, { error: "rate_limited", message: "Подождите 5 сек." }, "chat").message).toBe("Подождите 5 сек.");
    const internal = describeModelSaveError(500, { error: "internal_error", message: "Не удалось обновить модель проекта." }, "chat");
    expect(internal).toMatchObject({ action: null, lockSlot: false, missingKeyProvider: null });
    expect(describeModelSaveError(502, "<html>", "chat").action).toBeNull();
  });
});
