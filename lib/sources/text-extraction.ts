// lib/sources/text-extraction.ts
//
// Shared text extraction for any source that hands this pipeline raw file
// bytes: manual uploads (lib/sources/manual-upload.ts) and Google-Drive
// PDFs/txt/markdown downloaded as-is (lib/sources/google-drive.ts). Native
// Google Docs are NOT extracted here -- they're exported to plain text
// directly via the Drive API's export endpoint and never reach this
// module (see google-drive.ts). Kept as its own module specifically so
// google-drive.ts can reuse the PDF/text parsing rather than duplicating
// it.

export type ExtractionType = "pdf" | "markdown" | "text";

/** Detects extraction type from filename extension and/or MIME type -- either alone is enough (some upload paths only reliably have one or the other). Returns null for anything unsupported. */
export function detectExtractionType(filename: string, mimeType?: string | null): ExtractionType | null {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (mimeType === "application/pdf" || ext === "pdf") return "pdf";
  if (mimeType === "text/markdown" || ext === "md" || ext === "markdown") return "markdown";
  if (mimeType === "text/plain" || ext === "txt") return "text";
  return null;
}

/**
 * Extracts plain text from raw file bytes.
 *
 * PDF parsing uses `unpdf`, dynamically imported so the (non-trivial)
 * pdf.js module graph is only loaded on the PDF path. Chosen deliberately
 * over more common libraries like `pdf-parse`: unpdf ships a WASM/pure-JS
 * build of PDF.js purpose-built for serverless runtimes, with **no native
 * binary and no filesystem-path assumptions** -- a hard requirement here
 * per CLAUDE.md ("библиотекой, работающей в serverless-окружении Vercel,
 * без нативных бинарников"). Its one optional peer dependency
 * (`@napi-rs/canvas`, a native binary used only by unpdf's image-rendering
 * helpers) is never imported by this module, which only calls
 * `extractText()`.
 */
export async function extractText(buffer: Buffer, type: ExtractionType): Promise<string> {
  switch (type) {
    case "pdf": {
      const { extractText: extractPdfText } = await import("unpdf");
      const { text } = await extractPdfText(new Uint8Array(buffer), { mergePages: true });
      return text.trim();
    }
    case "markdown":
    case "text":
      // Decoded as UTF-8 unconditionally -- a known, acceptable MVP
      // limitation: files saved in legacy encodings (e.g. windows-1251)
      // will extract with mojibake. Same trade-off as lib/sources/url.ts.
      return buffer.toString("utf-8").trim();
  }
}
