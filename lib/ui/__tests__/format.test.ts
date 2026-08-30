import { describe, expect, it } from "vitest";
import {
  channelLabel,
  citationLabel,
  isLinkableRef,
  matchesConfirmationText,
  processingStatusLabel,
  resolveTelegramWebhookStatus,
  sourceLinkHref,
  sourceTypeLabel,
} from "../format";

describe("sourceTypeLabel", () => {
  it("labels every DocumentSourceType in Russian", () => {
    expect(sourceTypeLabel("manual_upload")).toBe("Загруженный файл");
    expect(sourceTypeLabel("notion")).toBe("Notion");
    expect(sourceTypeLabel("url")).toBe("Публичный URL");
    expect(sourceTypeLabel("google_drive")).toBe("Google Drive");
  });
});

describe("citationLabel", () => {
  it("phrases a manual_upload citation around the document title", () => {
    expect(citationLabel("manual_upload", "Handbook", null)).toBe("на основе документа «Handbook»");
  });

  it("phrases a notion citation around the page title", () => {
    expect(citationLabel("notion", "Onboarding", "abc123")).toBe("из Notion-страницы «Onboarding»");
  });

  it("phrases a url citation around the ref (falling back to title if ref is missing)", () => {
    expect(citationLabel("url", "Example", "https://example.com/page")).toBe(
      "со страницы по ссылке https://example.com/page"
    );
    expect(citationLabel("url", "Example", null)).toBe("со страницы по ссылке Example");
  });

  it("phrases a google_drive citation around the file title", () => {
    expect(citationLabel("google_drive", "Report.pdf", "file123")).toBe("из файла Google Drive «Report.pdf»");
  });
});

describe("isLinkableRef", () => {
  it("accepts http/https refs", () => {
    expect(isLinkableRef("https://example.com")).toBe(true);
    expect(isLinkableRef("http://example.com")).toBe(true);
  });

  it("rejects null, non-URL strings, and non-http(s) schemes", () => {
    expect(isLinkableRef(null)).toBe(false);
    expect(isLinkableRef("not a url")).toBe(false);
    expect(isLinkableRef("ftp://example.com")).toBe(false);
  });
});

describe("sourceLinkHref", () => {
  it("returns the ref as-is for a linkable url source", () => {
    expect(sourceLinkHref("url", "https://example.com/handbook")).toBe("https://example.com/handbook");
  });

  it("returns null for a url source whose ref isn't actually a linkable URL", () => {
    expect(sourceLinkHref("url", "not-a-url")).toBeNull();
  });

  it("builds a canonical notion.so deep link from a bare page id", () => {
    expect(sourceLinkHref("notion", "abcd-1234-efgh-5678")).toBe("https://www.notion.so/abcd1234efgh5678");
  });

  it("builds a canonical Drive deep link from a bare file id", () => {
    expect(sourceLinkHref("google_drive", "file123")).toBe("https://drive.google.com/file/d/file123/view");
  });

  it("is always null for manual_upload (no external location) and for a null ref", () => {
    expect(sourceLinkHref("manual_upload", "anything")).toBeNull();
    expect(sourceLinkHref("url", null)).toBeNull();
  });
});

describe("processingStatusLabel", () => {
  it("labels every ProcessingStatus in Russian", () => {
    expect(processingStatusLabel("pending")).toBe("В очереди");
    expect(processingStatusLabel("processing")).toBe("Обрабатывается");
    expect(processingStatusLabel("ready")).toBe("Готов к вопросам");
    expect(processingStatusLabel("error")).toBe("Ошибка");
  });
});

describe("channelLabel", () => {
  it("labels the known 'telegram' channel", () => {
    expect(channelLabel("telegram")).toBe("Telegram");
  });

  it("capitalizes an unrecognized channel rather than rendering nothing", () => {
    expect(channelLabel("slack")).toBe("Slack");
  });

  it("tolerates an empty string without throwing", () => {
    expect(channelLabel("")).toBe("");
  });
});

describe("resolveTelegramWebhookStatus", () => {
  it("passes through an explicit 'confirmed' value", () => {
    expect(resolveTelegramWebhookStatus("confirmed")).toBe("confirmed");
  });

  it("passes through an explicit 'unconfirmed' value", () => {
    expect(resolveTelegramWebhookStatus("unconfirmed")).toBe("unconfirmed");
  });

  it("defaults a missing value to 'unconfirmed' -- the more cautious/visible state, never silently 'confirmed'", () => {
    expect(resolveTelegramWebhookStatus(undefined)).toBe("unconfirmed");
  });
});

describe("matchesConfirmationText", () => {
  it("matches the exact project name", () => {
    expect(matchesConfirmationText("бот1", "бот1")).toBe(true);
  });

  it("tolerates leading/trailing whitespace in the typed input", () => {
    expect(matchesConfirmationText("  бот1  ", "бот1")).toBe(true);
  });

  it("is case-sensitive (does not treat 'Бот1' as matching 'бот1')", () => {
    expect(matchesConfirmationText("Бот1", "бот1")).toBe(false);
  });

  it("rejects a partial/incorrect match", () => {
    expect(matchesConfirmationText("бот", "бот1")).toBe(false);
    expect(matchesConfirmationText("", "бот1")).toBe(false);
  });

  it("never matches when the expected name is itself empty/whitespace-only", () => {
    expect(matchesConfirmationText("", "")).toBe(false);
    expect(matchesConfirmationText("   ", "   ")).toBe(false);
  });
});
