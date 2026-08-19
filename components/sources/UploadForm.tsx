"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { postFormData, retryAfterSuffix } from "./request-helpers";
import { redirectToLogin } from "@/lib/ui/client-redirect";

// Mirrors lib/sources/manual-upload.ts's MANUAL_UPLOAD_MAX_BYTES /
// lib/sources/text-extraction.ts's detectExtractionType -- duplicated
// here (not imported) because that module is `import "server-only"`-
// tagged and cannot be pulled into a "use client" bundle. This is a
// client-side fast-fail UX check only; the server re-validates both
// independently and is the actual source of truth (CLAUDE.md: never trust
// client-only validation).
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const ACCEPTED_EXTENSIONS = [".pdf", ".md", ".markdown", ".txt"];

function hasAcceptedExtension(filename: string): boolean {
  const lower = filename.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

interface UploadResult {
  documentId: string;
  chunkCount: number;
  status: string;
}

export function UploadForm() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    const file = inputRef.current?.files?.[0];
    if (!file) {
      setError("Выберите файл.");
      return;
    }
    if (!hasAcceptedExtension(file.name)) {
      setError("Поддерживаются только файлы PDF, Markdown (.md) и обычный текст (.txt).");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`Файл превышает лимит в ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} МБ.`);
      return;
    }

    setPending(true);
    const formData = new FormData();
    formData.append("file", file);
    const result = await postFormData<UploadResult>("/api/sources/upload", formData);
    setPending(false);

    if (!result.ok) {
      if (result.kind === "unauthorized") {
        redirectToLogin();
        return;
      }
      setError(result.message + retryAfterSuffix(result.retryAfterMs));
      return;
    }

    setSuccess(`Документ добавлен и готов к вопросам (${result.data.chunkCount} фрагментов).`);
    if (inputRef.current) inputRef.current.value = "";
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="source-form">
      <div className="field">
        <label htmlFor="upload-file">Файл (PDF, Markdown или TXT, до 20 МБ)</label>
        <input
          id="upload-file"
          ref={inputRef}
          type="file"
          className="input"
          accept=".pdf,.md,.markdown,.txt,application/pdf,text/markdown,text/plain"
          required
        />
      </div>
      {error ? (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      ) : null}
      {success ? (
        <div className="alert alert-info" role="status">
          {success}
        </div>
      ) : null}
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? "Загружаем и обрабатываем…" : "Загрузить"}
      </button>
    </form>
  );
}
