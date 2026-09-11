import { describe, expect, it } from "vitest";
import {
  describeAccountReadiness,
  describeProviderCapabilities,
  joinProviderLabels,
  providerLabel,
  providersForKind,
  type ConfiguredProviders,
} from "../provider-metadata";

const NONE: ConfiguredProviders = { openai: false, anthropic: false, gemini: false, voyage: false };

describe("providersForKind", () => {
  it("lists chat providers (no Voyage) and embedding providers (no Anthropic) in display order", () => {
    expect(providersForKind("chat")).toEqual(["openai", "anthropic", "gemini"]);
    expect(providersForKind("embedding")).toEqual(["openai", "gemini", "voyage"]);
  });
});

describe("providerLabel", () => {
  it("labels known providers and echoes an unknown one", () => {
    expect(providerLabel("voyage")).toBe("Voyage AI");
    expect(providerLabel("mistral")).toBe("mistral");
  });
});

describe("joinProviderLabels", () => {
  it("joins labels with a comma and a final «или»", () => {
    expect(joinProviderLabels([])).toBe("");
    expect(joinProviderLabels(["openai"])).toBe("OpenAI");
    expect(joinProviderLabels(["openai", "voyage"])).toBe("OpenAI или Voyage AI");
    expect(joinProviderLabels(["openai", "gemini", "voyage"])).toBe("OpenAI, Google Gemini или Voyage AI");
  });
});

describe("describeProviderCapabilities", () => {
  it("says what each provider's key enables", () => {
    expect(describeProviderCapabilities("openai")).toBe("чат и эмбеддинги (поиск по документам)");
    expect(describeProviderCapabilities("gemini")).toBe("чат и эмбеддинги (поиск по документам)");
    expect(describeProviderCapabilities("anthropic")).toBe("только чат");
    expect(describeProviderCapabilities("voyage")).toBe("только эмбеддинги (поиск по документам)");
  });
});

describe("describeAccountReadiness", () => {
  it("is ready for both kinds with one OpenAI (or Gemini) key", () => {
    expect(describeAccountReadiness({ ...NONE, openai: true })).toMatchObject({ chat: true, embedding: true });
    expect(describeAccountReadiness({ ...NONE, gemini: true })).toMatchObject({ chat: true, embedding: true });
  });

  it("asks for an embeddings key when only Anthropic is saved", () => {
    const readiness = describeAccountReadiness({ ...NONE, anthropic: true });
    expect(readiness).toMatchObject({ chat: true, embedding: false });
    expect(readiness.message).toContain("OpenAI, Google Gemini или Voyage AI");
  });

  it("asks for a chat key when only Voyage is saved", () => {
    const readiness = describeAccountReadiness({ ...NONE, voyage: true });
    expect(readiness).toMatchObject({ chat: false, embedding: true });
    expect(readiness.message).toContain("OpenAI, Anthropic Claude или Google Gemini");
  });

  it("covers both kinds with Anthropic + Voyage", () => {
    expect(describeAccountReadiness({ ...NONE, anthropic: true, voyage: true })).toMatchObject({ chat: true, embedding: true });
  });

  it("explains what is needed when no key is saved", () => {
    const readiness = describeAccountReadiness(NONE);
    expect(readiness).toMatchObject({ chat: false, embedding: false });
    expect(readiness.message).toContain("ни один ключ");
  });
});
