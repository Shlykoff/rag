import { describe, expect, it } from "vitest";
import { chunkText, estimateTokens } from "../chunk";

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function sentence(words: number, seed: string): string {
  const tokens = Array.from({ length: words }, (_, i) => `${seed}${i}`);
  tokens[0] = capitalize(tokens[0]);
  return tokens.join(" ") + ".";
}

function makeParagraph(sentences: number, wordsPerSentence: number, seed: string): string {
  return Array.from({ length: sentences }, (_, i) => sentence(wordsPerSentence, `${seed}-s${i}-w`)).join(" ");
}

describe("chunkText", () => {
  it("returns an empty array for empty input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  ")).toEqual([]);
  });

  it("returns a single chunk for text shorter than one chunk", () => {
    const text = "This is a short document. It has two sentences.";
    const chunks = chunkText(text, { targetTokens: 500 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(text);
    expect(chunks[0].index).toBe(0);
  });

  it("handles text with no sentence-ending punctuation (falls back to one chunk if short, or a forced chunk if long)", () => {
    const shortNoPunct = "just some words without any terminal punctuation at all";
    expect(chunkText(shortNoPunct, { targetTokens: 500 })).toHaveLength(1);

    // A very long run of text with zero sentence boundaries: splitIntoSentences
    // yields exactly one "sentence" the size of the whole paragraph, which is
    // then placed in its own chunk rather than being truncated.
    const longNoPunct = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkText(longNoPunct, { targetTokens: 100, overlapTokens: 10 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(longNoPunct);
  });

  it("splits a long multi-sentence document into multiple chunks near the target size", () => {
    // ~40 sentences of ~8 words each -> comfortably over a 100-token target.
    const paragraph = makeParagraph(40, 8, "p1");
    const chunks = chunkText(paragraph, { targetTokens: 100, overlapTokens: 15 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // Allow slack over target: a chunk can exceed targetTokens by up to
      // one sentence's worth (we never split mid-sentence), but shouldn't
      // wildly blow past it.
      expect(chunk.approxTokens).toBeLessThan(160);
      expect(chunk.approxTokens).toBeGreaterThan(0);
    }
    // Chunk indices are sequential starting at 0.
    chunks.forEach((c, i) => expect(c.index).toBe(i));
  });

  it("overlaps consecutive chunks by carrying trailing sentences forward", () => {
    const paragraph = makeParagraph(30, 8, "p2");
    const chunks = chunkText(paragraph, { targetTokens: 100, overlapTokens: 20 });
    expect(chunks.length).toBeGreaterThan(1);

    // The end of chunk[i] and the start of chunk[i+1] should share at
    // least one sentence (the carried-over overlap).
    for (let i = 0; i < chunks.length - 1; i++) {
      const endOfCurrent = chunks[i].content.split(". ").slice(-1)[0];
      expect(chunks[i + 1].content).toContain(endOfCurrent.replace(/\.$/, ""));
    }
  });

  // Regression test: overlapTokens: 0 is explicitly accepted as legal by
  // this function's own validation (overlapTokens must be >= 0), but the
  // overlap-carryover loop used to unconditionally carry at least one
  // trailing sentence into the next chunk regardless of overlapChars,
  // because the loop's break condition never fires on its first iteration
  // (overlapSentences.length > 0 is false before anything's been added
  // yet). Not reachable via today's production call site (which always
  // uses the default ~12% overlap), but exported/tested/documented as
  // supported behavior -- must genuinely produce zero overlap.
  it("produces genuinely ZERO overlap when overlapTokens: 0 is explicitly requested", () => {
    const paragraph = makeParagraph(30, 8, "p0");
    const chunks = chunkText(paragraph, { targetTokens: 100, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(1);

    for (let i = 0; i < chunks.length - 1; i++) {
      const currentSentences = chunks[i].content.split(/(?<=\.)\s+/);
      const nextSentences = chunks[i + 1].content.split(/(?<=\.)\s+/);
      const lastOfCurrent = currentSentences[currentSentences.length - 1];
      // With zero overlap, none of the trailing sentence(s) from chunk[i]
      // should reappear at the start of chunk[i+1].
      expect(nextSentences[0]).not.toBe(lastOfCurrent);
    }
  });

  it("never cuts a sentence in half -- every chunk is made of whole sentences", () => {
    const paragraph = makeParagraph(25, 10, "p3");
    const chunks = chunkText(paragraph, { targetTokens: 80, overlapTokens: 10 });
    for (const chunk of chunks) {
      // Every chunk should end at a sentence boundary (a period).
      expect(chunk.content.trim().endsWith(".")).toBe(true);
    }
  });

  it("respects paragraph breaks as natural boundaries", () => {
    const para1 = makeParagraph(5, 6, "para1");
    const para2 = makeParagraph(5, 6, "para2");
    const text = `${para1}\n\n${para2}`;
    const chunks = chunkText(text, { targetTokens: 1000 }); // large enough to fit both paragraphs in one chunk
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain("Para1-s0-w0");
    expect(chunks[0].content).toContain("para2-s4-w5");
  });

  it("throws on invalid options (overlap >= target, or non-positive target)", () => {
    expect(() => chunkText("text", { targetTokens: 0 })).toThrow();
    expect(() => chunkText("text", { targetTokens: 100, overlapTokens: 100 })).toThrow();
    expect(() => chunkText("text", { targetTokens: 100, overlapTokens: -1 })).toThrow();
  });

  it("estimateTokens scales roughly with text length (chars/4 heuristic)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("uses the documented defaults (650 target / ~78 overlap tokens, i.e. 12%) when no options are given", () => {
    // A document sized to require multiple default-sized chunks.
    const paragraph = makeParagraph(120, 10, "def");
    const chunks = chunkText(paragraph);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks.slice(0, -1)) {
      // Chunks (other than possibly the last) should land close to the
      // 500-800 token range from CLAUDE.md/spec.md.
      expect(chunk.approxTokens).toBeGreaterThan(400);
      expect(chunk.approxTokens).toBeLessThan(900);
    }
  });
});
