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

export function NotionForm({ initialConnected }: { initialConnected: boolean }) {
  const router = useRouter();
  const [connected, setConnected] = useState(initialConnected);

  const [secret, setSecret] = useState("");
  const [savingSecret, setSavingSecret] = useState(false);
  const [secretError, setSecretError] = useState<string | null>(null);

  const [pageUrl, setPageUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);

  async function handleSaveSecret(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSecretError(null);
    if (!secret.trim()) {
      setSecretError("Вставьте Internal Integration Secret.");
      return;
    }
    setSavingSecret(true);
    const result = await postJson<{ status: string }>("/api/sources/credentials", {
      sourceType: "notion",
      credential: secret.trim(),
    });
    setSavingSecret(false);
    if (!result.ok) {
      if (result.kind === "unauthorized") {
        redirectToLogin();
        return;
      }
      setSecretError(result.message + retryAfterSuffix(result.retryAfterMs));
      return;
    }
    setConnected(true);
    setSecret("");
  }

  async function handleImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setImportError(null);
    setImportSuccess(null);
    if (!pageUrl.trim()) {
      setImportError("Вставьте ссылку на страницу или базу Notion.");
      return;
    }
    setImporting(true);
    const result = await postJson<ImportResult>("/api/sources/notion", { pageUrl: pageUrl.trim() });
    setImporting(false);
    if (!result.ok) {
      if (result.kind === "unauthorized") {
        redirectToLogin();
        return;
      }
      setImportError(result.message + retryAfterSuffix(result.retryAfterMs));
      return;
    }
    setImportSuccess(`Документ добавлен и готов к вопросам (${result.data.chunkCount} фрагментов).`);
    setPageUrl("");
    router.refresh();
  }

  return (
    <div className="source-form">
      <ol className="source-instructions">
        <li>
          Создайте internal integration на{" "}
          <a href="https://www.notion.so/my-integrations" target="_blank" rel="noopener noreferrer">
            notion.so/my-integrations
          </a>{" "}
          и скопируйте её Internal Integration Secret.
        </li>
        <li>Вставьте секрет ниже — он хранится в зашифрованном виде.</li>
        <li>
          На нужной странице Notion откройте <strong>Share → Connections</strong> и расшарьте её на созданную
          интеграцию — без этого шага импорт вернёт ошибку «страница не расшарена».
        </li>
        <li>Вставьте ссылку на страницу (или базу) и импортируйте.</li>
      </ol>

      {!connected ? (
        <form onSubmit={handleSaveSecret} style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
          <div className="field">
            <label htmlFor="notion-secret">Internal Integration Secret</label>
            <input
              id="notion-secret"
              type="password"
              className="input"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="secret_..."
              autoComplete="off"
              required
            />
          </div>
          {secretError ? (
            <div className="alert alert-danger" role="alert">
              {secretError}
            </div>
          ) : null}
          <button type="submit" className="btn btn-secondary" disabled={savingSecret}>
            {savingSecret ? "Сохраняем…" : "Сохранить токен"}
          </button>
        </form>
      ) : (
        <>
          <div className="alert alert-info">Notion подключён. Токен сохранён — можно импортировать страницы.</div>
          <form onSubmit={handleImport} style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            <div className="field">
              <label htmlFor="notion-page-url">Ссылка на страницу или базу Notion</label>
              <input
                id="notion-page-url"
                type="text"
                className="input"
                value={pageUrl}
                onChange={(e) => setPageUrl(e.target.value)}
                placeholder="https://www.notion.so/..."
                required
              />
            </div>
            {importError ? (
              <div className="alert alert-danger" role="alert">
                {importError}
              </div>
            ) : null}
            {importSuccess ? (
              <div className="alert alert-info" role="status">
                {importSuccess}
              </div>
            ) : null}
            <div style={{ display: "flex", gap: "0.6rem" }}>
              <button type="submit" className="btn btn-primary" disabled={importing}>
                {importing ? "Импортируем…" : "Импортировать"}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConnected(false)}>
                Заменить токен
              </button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
