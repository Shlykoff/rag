import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const mockIngest = vi.fn();

vi.mock("../../ingestion/ingest", () => ({
  ingestDocumentWithDefaultProviders: (...args: unknown[]) => mockIngest(...args),
}));
vi.mock("../url", () => ({ importUrlDocument: vi.fn() }));
vi.mock("../notion", () => ({ importNotionDocument: vi.fn() }));
vi.mock("../google-drive", () => ({ importSingleDriveFile: vi.fn() }));

import { createDocumentFromSource, type CreateDocumentParams } from "../pipeline";

function makeFakeSupabase(options: { uploadError?: string; updateError?: string } = {}) {
  const deletedDocumentIds: string[] = [];
  const removedPaths: string[][] = [];
  const supabase = {
    from(table: string) {
      if (table !== "documents") throw new Error(`unexpected table ${table}`);
      return {
        insert: () => ({ select: () => ({ single: async () => ({ data: { id: "doc-1" }, error: null }) }) }),
        update: () => ({ eq: async () => ({ error: options.updateError ? { message: options.updateError } : null }) }),
        delete: () => ({
          eq: async (_column: string, id: string) => {
            deletedDocumentIds.push(id);
            return { error: null };
          },
        }),
      };
    },
    storage: {
      from: () => ({
        upload: async () => ({ error: options.uploadError ? { message: options.uploadError } : null }),
        remove: async (paths: string[]) => {
          removedPaths.push(paths);
          return { error: null };
        },
      }),
    },
  } as unknown as SupabaseClient;
  return { supabase, deletedDocumentIds, removedPaths };
}

const params: CreateDocumentParams = {
  projectId: "project-1",
  ownerUserId: "owner-1",
  title: "Doc",
  sourceType: "manual_upload",
  sourceRef: null,
  text: "Some text.",
  object: { suffix: "original.txt", content: "Some text.", contentType: "text/plain" },
};

describe("createDocumentFromSource", () => {
  beforeEach(() => mockIngest.mockReset());

  it("deletes the new row when the Storage upload fails, so it never sits in 'pending'", async () => {
    const { supabase, deletedDocumentIds, removedPaths } = makeFakeSupabase({ uploadError: "bucket unavailable" });

    await expect(createDocumentFromSource(supabase, params)).rejects.toThrow(/bucket unavailable/);

    expect(deletedDocumentIds).toEqual(["doc-1"]);
    expect(removedPaths).toEqual([]);
    expect(mockIngest).not.toHaveBeenCalled();
  });

  it("removes the uploaded object and the row when setting storage_path fails", async () => {
    const { supabase, deletedDocumentIds, removedPaths } = makeFakeSupabase({ updateError: "update failed" });

    await expect(createDocumentFromSource(supabase, params)).rejects.toThrow(/update failed/);

    expect(removedPaths).toEqual([["project-1/doc-1/original.txt"]]);
    expect(deletedDocumentIds).toEqual(["doc-1"]);
    expect(mockIngest).not.toHaveBeenCalled();
  });

  it("hands the stored document to ingestion and keeps the row on success", async () => {
    const { supabase, deletedDocumentIds } = makeFakeSupabase();
    mockIngest.mockResolvedValue({ documentId: "doc-1", chunkCount: 1, embeddingProvider: "p", embeddingModel: "m" });

    await createDocumentFromSource(supabase, params);

    expect(mockIngest).toHaveBeenCalledWith({
      documentId: "doc-1",
      projectId: "project-1",
      ownerUserId: "owner-1",
      title: "Doc",
      text: "Some text.",
    });
    expect(deletedDocumentIds).toEqual([]);
  });
});
