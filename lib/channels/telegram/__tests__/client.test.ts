import { describe, expect, it, vi, afterEach } from "vitest";
import { splitTelegramMessage, sendTelegramMessage, setTelegramWebhook, getTelegramWebhookInfo } from "../client";

describe("splitTelegramMessage", () => {
  it("returns the text unchanged (as a single-element array) when under the limit", () => {
    expect(splitTelegramMessage("hello world", 100)).toEqual(["hello world"]);
  });

  it("returns an empty array for empty text", () => {
    expect(splitTelegramMessage("", 100)).toEqual([]);
  });

  it("splits text longer than maxLength into multiple chunks, each within the limit", () => {
    const text = "word ".repeat(500); // 2500 chars
    const chunks = splitTelegramMessage(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });

  it("reassembles to the same words in order (no content lost/duplicated at boundaries)", () => {
    const words = Array.from({ length: 300 }, (_, i) => `word${i}`);
    const text = words.join(" ");
    const chunks = splitTelegramMessage(text, 120);
    const reassembledWords = chunks.join(" ").split(/\s+/).filter(Boolean);
    expect(reassembledWords).toEqual(words);
  });

  it("prefers breaking at a paragraph boundary over a hard cut", () => {
    const paragraph1 = "a".repeat(40);
    const paragraph2 = "b".repeat(40);
    const text = `${paragraph1}\n\n${paragraph2}`;
    const chunks = splitTelegramMessage(text, 50);
    expect(chunks[0]).toBe(paragraph1);
    expect(chunks[1]).toBe(paragraph2);
  });

  it("falls back to a hard cut when there is no whitespace to break on at all", () => {
    const text = "a".repeat(250);
    const chunks = splitTelegramMessage(text, 100);
    expect(chunks).toEqual(["a".repeat(100), "a".repeat(100), "a".repeat(50)]);
  });

  // Regression test: a hard cut (no whitespace boundary nearby) landing
  // exactly inside a UTF-16 surrogate pair (e.g. most emoji are two 16-bit
  // code units in JS strings) used to silently split the pair in half,
  // corrupting both resulting chunks into lone unpaired surrogates.
  // Engineered so `maxLength` lands exactly between the emoji's high and
  // low surrogate: 99 plain chars, then the emoji at indices 99-100, cut at
  // 100 -- i.e. precisely inside the pair before the fix.
  it("backs off one character instead of splitting a UTF-16 surrogate pair on a hard cut", () => {
    const emoji = "\u{1F600}"; // U+1F600 GRINNING FACE -- a surrogate pair in UTF-16
    const text = "a".repeat(99) + emoji + "a".repeat(50);
    const chunks = splitTelegramMessage(text, 100);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const last = chunk.charCodeAt(chunk.length - 1);
      const first = chunk.charCodeAt(0);
      // No chunk may end with a dangling high surrogate or start with a
      // dangling low surrogate -- both are the signature of a split pair.
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
    }
    // Rejoining every chunk reproduces the original text exactly, emoji
    // intact -- proves no code unit was dropped or duplicated at the cut.
    expect(chunks.join("")).toBe(text);
    expect(chunks.join("")).toContain(emoji);
  });

  it("uses Telegram's real 4096-char default limit when no maxLength is passed", () => {
    const text = "x".repeat(5000);
    const chunks = splitTelegramMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].length).toBeLessThanOrEqual(4096);
  });
});

describe("sendTelegramMessage / setTelegramWebhook (fetch-level contract)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sendTelegramMessage sends one request per chunk, in order, with no parse_mode field", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(init.body as string) });
        return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
      })
    );

    const longText = "word ".repeat(2000); // forces multiple chunks
    await sendTelegramMessage("test-token", "12345", longText);

    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      expect(call.url).toContain("/bottest-token/sendMessage");
      expect(call.body).toMatchObject({ chat_id: "12345" });
      expect(call.body).not.toHaveProperty("parse_mode");
    }
  });

  it("sendTelegramMessage throws a descriptive error (with the token redacted) when Telegram reports a failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 400 }))
    );

    const err = await sendTelegramMessage("secret-token-value", "12345", "hi").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/chat not found/);
    expect((err as Error).message).not.toContain("secret-token-value");
  });

  it("setTelegramWebhook posts url + secret_token + allowed_updates", async () => {
    let capturedBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      })
    );

    await setTelegramWebhook("test-token", "https://example.com/webhook/abc", "shh-secret");

    expect(capturedBody).toEqual({
      url: "https://example.com/webhook/abc",
      secret_token: "shh-secret",
      allowed_updates: ["message"],
    });
  });

  it("getTelegramWebhookInfo returns the registered url from Telegram's response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ ok: true, result: { url: "https://example.com/api/channels/telegram/abc", pending_update_count: 0 } }),
          { status: 200 }
        )
      )
    );

    const info = await getTelegramWebhookInfo("test-token");
    expect(info).toEqual({ url: "https://example.com/api/channels/telegram/abc" });
  });

  it("getTelegramWebhookInfo returns an empty url when no webhook is registered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { url: "", pending_update_count: 0 } }), { status: 200 }))
    );

    const info = await getTelegramWebhookInfo("test-token");
    expect(info).toEqual({ url: "" });
  });

  it("getTelegramWebhookInfo throws (token redacted) when Telegram rejects the token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 }))
    );

    const err = await getTelegramWebhookInfo("secret-token-value").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("secret-token-value");
  });
});
