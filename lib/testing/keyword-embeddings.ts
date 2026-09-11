// lib/testing/keyword-embeddings.ts
//
// A toy, deterministic EmbeddingsProvider for integration tests (and the
// README's "Chunking parameters" examples): a bag-of-words hashing
// embedding that captures keyword overlap, nothing like a real model's
// semantics. It lets ranking be checked end to end against real
// Postgres/pgvector without a provider API key. NEVER use this outside tests.

import type { EmbeddingsProvider } from "../ai/types";

export interface KeywordEmbeddingsOptions {
  /** Any dimension the catalog uses; 1024 by default. */
  dimensions?: number;
  providerName?: string;
  /** Written to document_chunks.embedding_model -- use a catalog model_id to mimic that model. */
  modelName?: string;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s]/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2); // drop very short/stop-word-ish tokens
}

/** Deterministic string hash (djb2) folded into [0, dimensions). */
function hashToIndex(word: string, dimensions: number): number {
  let hash = 5381;
  for (let i = 0; i < word.length; i++) {
    hash = (hash * 33) ^ word.charCodeAt(i);
  }
  return Math.abs(hash) % dimensions;
}

function bagOfWordsVector(text: string, dimensions: number): number[] {
  const vector = new Array(dimensions).fill(0);
  for (const word of tokenize(text)) {
    vector[hashToIndex(word, dimensions)] += 1;
  }
  return vector;
}

export function createKeywordEmbeddingsProvider(options: KeywordEmbeddingsOptions = {}): EmbeddingsProvider {
  const dimensions = options.dimensions ?? 1024;
  return {
    providerName: options.providerName ?? "keyword-toy",
    modelName: options.modelName ?? "bag-of-words-hash-v1",
    dimensions,
    embed: async (texts: string[]) => texts.map((text) => bagOfWordsVector(text, dimensions)),
  };
}
