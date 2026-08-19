import { describe, expect, it } from "vitest";
import { assembleContext, type MatchedChunk } from "../search";

function makeChunk(overrides: Partial<MatchedChunk> = {}): MatchedChunk {
  return {
    chunk_id: "chunk-1",
    document_id: "doc-1",
    content: "Some chunk content.",
    chunk_index: 0,
    page_number: null,
    chunk_position: 0,
    similarity: 0.9,
    document_title: "Doc Title",
    document_source_type: "manual_upload",
    document_source_ref: null,
    ...overrides,
  };
}

describe("assembleContext", () => {
  it("returns empty context and no sources for zero matches", () => {
    const result = assembleContext([], 1000);
    expect(result.contextText).toBe("");
    expect(result.sources).toEqual([]);
  });

  it("includes all matches when comfortably under the token budget", () => {
    const matches = [
      makeChunk({ chunk_id: "a", content: "First chunk." }),
      makeChunk({ chunk_id: "b", content: "Second chunk." }),
    ];
    const result = assembleContext(matches, 1000);
    expect(result.sources).toHaveLength(2);
    expect(result.contextText).toContain("First chunk.");
    expect(result.contextText).toContain("Second chunk.");
    expect(result.contextText).toContain("[1]");
    expect(result.contextText).toContain("[2]");
  });

  it("stops adding chunks once the token budget would be exceeded", () => {
    // Each chunk content is ~400 chars => ~100 tokens estimated.
    const bigContent = "word ".repeat(80);
    const matches = [
      makeChunk({ chunk_id: "a", content: bigContent }),
      makeChunk({ chunk_id: "b", content: bigContent }),
      makeChunk({ chunk_id: "c", content: bigContent }),
    ];
    // Budget for ~1.5 chunks -> only the first should fit.
    const result = assembleContext(matches, 150);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].chunkId).toBe("a");
  });

  it("always includes at least one chunk even if it alone exceeds the budget", () => {
    const hugeContent = "word ".repeat(10_000);
    const matches = [makeChunk({ chunk_id: "a", content: hugeContent })];
    const result = assembleContext(matches, 10); // tiny budget
    expect(result.sources).toHaveLength(1);
    expect(result.contextText.length).toBeGreaterThan(0);
  });

  it("preserves RPC similarity order (most-similar-first) in the output", () => {
    const matches = [
      makeChunk({ chunk_id: "most-similar", similarity: 0.95 }),
      makeChunk({ chunk_id: "less-similar", similarity: 0.80 }),
    ];
    const result = assembleContext(matches, 1000);
    expect(result.sources.map((s) => s.chunkId)).toEqual(["most-similar", "less-similar"]);
  });

  it("labels the source type in Russian and includes page/position info when present", () => {
    const withPage = assembleContext(
      [makeChunk({ document_source_type: "manual_upload", page_number: 3, chunk_position: null })],
      1000
    );
    expect(withPage.contextText).toContain("загруженный файл");
    expect(withPage.contextText).toContain("стр. 3");

    const withPosition = assembleContext(
      [makeChunk({ document_source_type: "notion", page_number: null, chunk_position: 4 })],
      1000
    );
    expect(withPosition.contextText).toContain("страница Notion");
    expect(withPosition.contextText).toContain("фрагмент 5"); // 0-based chunk_position + 1

    const url = assembleContext([makeChunk({ document_source_type: "url" })], 1000);
    expect(url.contextText).toContain("веб-страница");

    const drive = assembleContext([makeChunk({ document_source_type: "google_drive" })], 1000);
    expect(drive.contextText).toContain("файл из Google Drive");
  });

  it("returned sources carry every field the UI needs for citation", () => {
    const result = assembleContext(
      [
        makeChunk({
          chunk_id: "c1",
          document_id: "d1",
          document_title: "My Doc",
          document_source_type: "url",
          document_source_ref: "https://example.com",
          page_number: null,
          chunk_position: 2,
          similarity: 0.87,
        }),
      ],
      1000
    );
    expect(result.sources[0]).toEqual({
      chunkId: "c1",
      documentId: "d1",
      documentTitle: "My Doc",
      sourceType: "url",
      sourceRef: "https://example.com",
      pageNumber: null,
      chunkPosition: 2,
      similarity: 0.87,
    });
  });
});
