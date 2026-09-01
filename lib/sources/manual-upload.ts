// lib/sources/manual-upload.ts
//
// Manual file upload source: PDF/markdown/txt, extracted to plain text via
// lib/sources/text-extraction.ts. No external auth (the file is already in
// the user's hands) and no "Refresh" (there's nothing external to
// re-fetch -- see the documents migration's last_synced_at column comment
// and lib/ingestion/ingest.ts, which deliberately never stamps
// last_synced_at for source_type = 'manual_upload').

import "server-only";
import { SourceError } from "./errors";
import { detectExtractionType, extractText } from "./text-extraction";
import type { DocumentSource } from "./types";

// 20MB: bounds extraction time/memory for a single serverless invocation,
// not a limit expected to bind for ordinary text-heavy documents (policies,
// guides, reports) even at a few hundred pages. NOTE: this is an
// application-level ceiling -- Vercel's own Serverless/Edge Function
// request body limit (historically ~4.5MB on the Node.js runtime,
// platform-dependent) may reject a request before it ever reaches this
// check when deployed there. If larger uploads need to work in production,
// the fix is a direct-to-Supabase-Storage upload flow from the client
// (bypass the serverless function body), not raising this constant.
export const MANUAL_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

export interface ManualUploadInput {
  filename: string;
  mimeType: string | null;
  buffer: Buffer;
}

/**
 * Conforms to the `DocumentSource` contract (lib/sources/types.ts), matching
 * the `{title, text, sourceType, sourceRef}` shape CLAUDE.md specifies every
 * source normalizes down to. `sourceType` is always the `"manual_upload"`
 * literal and `sourceRef` is always `null` (manual uploads have nothing
 * external to re-fetch -- see NormalizedDocument.sourceRef's own doc
 * comment and the `documents_source_ref_required_unless_manual` DB
 * constraint).
 */
export interface ManualUploadResult extends DocumentSource {
  sourceType: "manual_upload";
  sourceRef: null;
  /** Raw bytes to persist verbatim as the Storage "original" object -- manual_upload's storage_path always holds the original file, not a text cache (see the documents migration's storage_path comment). */
  original: {
    buffer: Buffer;
    extension: string;
    contentType: string;
  };
}

function deriveTitleFromFilename(filename: string): string {
  const withoutExtension = filename.replace(/\.[^./\\]+$/, "").trim();
  return withoutExtension || filename;
}

/** Validates, then extracts text from, one uploaded file. Throws SourceError on anything not fit to ingest (empty, oversized, unsupported type, no extractable text) -- the caller (app/api/sources/upload/route.ts) never needs its own validation logic beyond checking the request shape. */
export async function processManualUpload(input: ManualUploadInput): Promise<ManualUploadResult> {
  if (input.buffer.length === 0) {
    throw new SourceError({
      source: "manual_upload",
      kind: "invalid_input",
      message: `empty file: ${input.filename}`,
      userMessage: "Файл пустой.",
    });
  }
  if (input.buffer.length > MANUAL_UPLOAD_MAX_BYTES) {
    throw new SourceError({
      source: "manual_upload",
      kind: "too_large",
      message: `file ${input.filename} is ${input.buffer.length} bytes, limit is ${MANUAL_UPLOAD_MAX_BYTES}`,
      userMessage: `Файл слишком большой (максимум ${Math.round(MANUAL_UPLOAD_MAX_BYTES / (1024 * 1024))}MB).`,
    });
  }

  const type = detectExtractionType(input.filename, input.mimeType);
  if (!type) {
    throw new SourceError({
      source: "manual_upload",
      kind: "unsupported_file_type",
      message: `unsupported file: ${input.filename} (${input.mimeType ?? "no mime type"})`,
      userMessage: "Поддерживаются только файлы PDF, Markdown (.md) и обычный текст (.txt).",
    });
  }

  const text = await extractText(input.buffer, type);
  if (!text.trim()) {
    throw new SourceError({
      source: "manual_upload",
      kind: "empty_content",
      message: `no extractable text in ${input.filename}`,
      userMessage: "Не удалось извлечь текст из файла -- возможно, документ пустой или состоит только из изображений.",
    });
  }

  const extension = type === "pdf" ? "pdf" : type === "markdown" ? "md" : "txt";
  const contentType = type === "pdf" ? "application/pdf" : type === "markdown" ? "text/markdown" : "text/plain";

  return {
    title: deriveTitleFromFilename(input.filename),
    text,
    sourceType: "manual_upload",
    sourceRef: null,
    original: { buffer: input.buffer, extension, contentType },
  };
}
