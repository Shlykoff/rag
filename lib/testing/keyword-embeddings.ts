// lib/testing/keyword-embeddings.ts
//
// A toy, deterministic EmbeddingsProvider used ONLY by
// lib/retrieval/__tests__/chunking-quality.integration.test.ts (and
// documented in README's "Chunking parameters" section) to demonstrate
// that the chunking + retrieval *ranking* pipeline behaves correctly end
// to end against a real Postgres/pgvector instance, without a real AI
// provider API key (none are available yet -- see README "What hasn't
// been tested live"). It is a crude bag-of-words hashing embedding: it
// captures keyword overlap, nothing like the semantic quality of a real
// embedding model (OpenAI/Voyage/Gemini). NEVER use this outside tests.

import type { EmbeddingsProvider } from "../ai/types";

const DIMENSIONS = 1024; // matches document_chunks.embedding vector(1024) -- see CLAUDE.md / lib/ai/types.ts

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s]/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2); // drop very short/stop-word-ish tokens
}

/** Deterministic string hash (djb2) folded into [0, DIMENSIONS). */
function hashToIndex(word: string): number {
  let hash = 5381;
  for (let i = 0; i < word.length; i++) {
    hash = (hash * 33) ^ word.charCodeAt(i);
  }
  return Math.abs(hash) % DIMENSIONS;
}

function bagOfWordsVector(text: string): number[] {
  const vector = new Array(DIMENSIONS).fill(0);
  for (const word of tokenize(text)) {
    vector[hashToIndex(word)] += 1;
  }
  return vector;
}

export function createKeywordEmbeddingsProvider(): EmbeddingsProvider {
  return {
    providerName: "keyword-toy",
    modelName: "bag-of-words-hash-v1",
    dimensions: DIMENSIONS,
    embed: async (texts: string[]) => texts.map(bagOfWordsVector),
  };
}
