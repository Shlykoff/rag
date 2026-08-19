"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { postJson, retryAfterSuffix } from "./request-helpers";
import { redirectToLogin } from "@/lib/ui/client-redirect";

interface ImportResult {
  documentId: string;
  chunkCount: number;
  status: string;
}

export function UrlForm() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    const trimmed = url.trim();
    if (!trimmed) {
      setError("Введите ссылку.");
      return;
    }
    // Client-side scheme check is UX-only, not the security boundary --
    // the actual SSRF protection (scheme allowlist, private/link-local IP
    // rejection, redirect re-validation) lives server-side in
    // lib/sources/net/ (see CLAUDE.md's SSRF requirement) and cannot be
    // replicated meaningfully in the browser (DNS resolution isn't even
    // available here).
    if (!/^https?:\/\//i.test(trimmed)) {
      setError("Ссылка должна начинаться с http:// или https://.");
      return;
    }

    setPending(true);
    const result = await postJson<ImportResult>("/api/sources/url", { url: trimmed });
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
    setUrl("");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="source-form">
      <div className="field">
        <label htmlFor="public-url">Публичная ссылка</label>
        <input
          id="public-url"
          type="url"
          className="input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/handbook/onboarding"
          required
        />
        <p className="field-hint">
          Страница должна быть публично доступной (без авторизации). Приватные/локальные адреса
          заблокированы из соображений безопасности.
        </p>
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
        {pending ? "Загружаем…" : "Добавить"}
      </button>
    </form>
  );
}
