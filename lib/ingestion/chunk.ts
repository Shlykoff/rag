// lib/ingestion/chunk.ts
//
// Pure, provider-agnostic text chunker. Takes the plain text already
// normalized by document-sources-specialist (PDF/markdown/txt/Notion/
// URL/Drive all arrive here as one plain string) and splits it into
// overlapping chunks sized for embedding + retrieval.
//
// See the README "Chunking parameters" section for the target size/overlap
// rationale and the "вопрос -> источник" quality examples that justify it.

// Token estimation (chars/4 heuristic) lives in lib/tokens.ts, shared with
// lib/retrieval/search.ts's context token budget -- see that file for the
// full rationale. Re-exported here so existing imports of
// `estimateTokens` from this module keep working.
import { estimateTokens, tokensToChars } from "../tokens";
export { estimateTokens };

export interface ChunkOptions {
  /** Target chunk size in (estimated) tokens. Default 650, the middle of the 500-800 range -- see README for why. */
  targetTokens?: number;
  /** Overlap between consecutive chunks, in (estimated) tokens. Default ~12% of targetTokens, within the 10-15% range from CLAUDE.md/spec.md. */
  overlapTokens?: number;
}

export interface Chunk {
  /** 0-based position of this chunk within the document -- maps directly to document_chunks.chunk_index / chunk_position. */
  index: number;
  content: string;
  /** Estimated token count for this chunk (see estimateTokens) -- useful for logging/debugging chunk sizing, not stored verbatim in the DB. */
  approxTokens: number;
}

const DEFAULT_TARGET_TOKENS = 650;
const DEFAULT_OVERLAP_RATIO = 0.12;

/**
 * Splits `text` into paragraphs (blank-line-separated), then sentences
 * within paragraphs, and greedily packs sentences into chunks up to
 * ~targetTokens, carrying the trailing ~overlapTokens worth of sentences
 * into the next chunk. This keeps chunk boundaries on sentence/paragraph
 * edges rather than cutting mid-word or mid-sentence, per CLAUDE.md.
 *
 * A single sentence longer than targetTokens (rare, but real for
 * un-punctuated text like code blocks or URLs pasted inline) is placed in
 * its own chunk rather than being truncated or force-split mid-word --
 * losing a little bit of "ideal" chunk sizing is preferable to silently
 * dropping/corrupting content.
 */
export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const targetTokens = options.targetTokens ?? DEFAULT_TARGET_TOKENS;
  const overlapTokens =
    options.overlapTokens ?? Math.round(targetTokens * DEFAULT_OVERLAP_RATIO);

  if (targetTokens <= 0) {
    throw new Error("chunkText: targetTokens must be > 0");
  }
  if (overlapTokens < 0 || overlapTokens >= targetTokens) {
    throw new Error(
      "chunkText: overlapTokens must be >= 0 and < targetTokens"
    );
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  const sentences = splitIntoSentences(trimmed);
  if (sentences.length === 0) return [];

  const targetChars = tokensToChars(targetTokens);
  const overlapChars = tokensToChars(overlapTokens);

  const chunks: Chunk[] = [];
  let current: string[] = [];
  let currentLength = 0; // chars, including separators, kept approximate

  const flush = () => {
    if (current.length === 0) return;
    const content = current.join(" ").trim();
    if (content.length === 0) return;
    chunks.push({
      index: chunks.length,
      content,
      approxTokens: estimateTokens(content),
    });
  };

  for (const sentence of sentences) {
    const sentenceLength = sentence.length;

    // A lone sentence that alone exceeds the target: emit whatever we've
    // accumulated so far as its own chunk, then this oversized sentence as
    // its own chunk too, rather than truncating it.
    if (sentenceLength > targetChars && current.length === 0) {
      chunks.push({
        index: chunks.length,
        content: sentence,
        approxTokens: estimateTokens(sentence),
      });
      continue;
    }

    if (currentLength + sentenceLength > targetChars && current.length > 0) {
      flush();
      // Carry over trailing sentences worth ~overlapChars into the next
      // chunk, walking backwards from the end of the chunk we just closed.
      // Guarded by `overlapChars > 0`: without the guard, the loop below
      // always unshifts at least one sentence on its first iteration even
      // when `overlapTokens: 0` was requested (a legal value), producing
      // unwanted overlap instead of none.
      const overlapSentences: string[] = [];
      let overlapLength = 0;
      if (overlapChars > 0) {
        for (let i = current.length - 1; i >= 0; i--) {
          const s = current[i];
          if (overlapLength + s.length > overlapChars && overlapSentences.length > 0) {
            break;
          }
          overlapSentences.unshift(s);
          overlapLength += s.length + 1;
        }
      }
      current = overlapSentences;
      currentLength = overlapLength;
    }

    current.push(sentence);
    currentLength += sentenceLength + 1;
  }
  flush();

  return chunks;
}

/**
 * Splits text into paragraphs on blank lines, then into sentences within
 * each paragraph via a simple punctuation-based regex (./!/? followed by
 * whitespace) -- an approximation, same spirit as estimateTokens, good
 * enough for chunk-boundary purposes without a full NLP sentence tokenizer.
 * A paragraph break is preserved as its own boundary so chunks still tend
 * to respect paragraph structure, not just sentences.
 */
function splitIntoSentences(text: string): string[] {
  const paragraphs = text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const sentences: string[] = [];
  for (const paragraph of paragraphs) {
    // Collapse internal whitespace/newlines within a paragraph so wrapped
    // lines don't produce spurious short "sentences".
    const normalized = paragraph.replace(/\s+/g, " ").trim();
    const parts = normalized.split(/(?<=[.!?])\s+(?=[A-ZА-ЯЁ0-9"'«(])/u);
    for (const part of parts) {
      const trimmedPart = part.trim();
      if (trimmedPart.length > 0) sentences.push(trimmedPart);
    }
  }
  return sentences;
}
