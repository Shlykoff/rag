"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { postJson, retryAfterSuffix } from "./request-helpers";
import { redirectToLogin } from "@/lib/ui/client-redirect";

interface SyncResult {
  imported: { fileId: string; documentId: string | null; status: "ready" | "error" }[];
  skipped: unknown[];
}

export function GoogleDriveForm({ initialConnected }: { initialConnected: boolean }) {
  const router = useRouter();
  const [connected, setConnected] = useState(initialConnected);

  const [json, setJson] = useState("");
  const [savingJson, setSavingJson] = useState(false);
  const [jsonError, setJsonError] = useState<string | null>(null);

  const [folderId, setFolderId] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncSuccess, setSyncSuccess] = useState<string | null>(null);

  async function handleSaveJson(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setJsonError(null);
    const trimmed = json.trim();
    if (!trimmed) {
      setJsonError("Вставьте JSON-ключ сервисного аккаунта.");
      return;
    }
    try {
      JSON.parse(trimmed);
    } catch {
      setJsonError("Это не похоже на валидный JSON — вставьте файл ключа целиком.");
      return;
    }
    setSavingJson(true);
    const result = await postJson<{ status: string }>("/api/sources/credentials", {
      sourceType: "google_drive",
      credential: trimmed,
    });
    setSavingJson(false);
    if (!result.ok) {
      if (result.kind === "unauthorized") {
        redirectToLogin();
        return;
      }
      setJsonError(result.message + retryAfterSuffix(result.retryAfterMs));
      return;
    }
    setConnected(true);
    setJson("");
  }

  async function handleSync(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSyncError(null);
    setSyncSuccess(null);
    if (!folderId.trim()) {
      setSyncError("Укажите Folder ID папки Google Drive.");
      return;
    }
    setSyncing(true);
    const result = await postJson<SyncResult>("/api/sources/google-drive", { folderId: folderId.trim() });
    setSyncing(false);
    if (!result.ok) {
      if (result.kind === "unauthorized") {
        redirectToLogin();
        return;
      }
      setSyncError(result.message + retryAfterSuffix(result.retryAfterMs));
      return;
    }
    const ready = result.data.imported.filter((f) => f.status === "ready").length;
    const failed = result.data.imported.filter((f) => f.status === "error").length;
    setSyncSuccess(
      `Синхронизировано файлов: ${ready}${failed > 0 ? `, с ошибкой: ${failed}` : ""}${
        result.data.skipped.length > 0 ? `, пропущено: ${result.data.skipped.length}` : ""
      }.`
    );
    router.refresh();
  }

  return (
    <div className="source-form">
      <ol className="source-instructions">
        <li>Создайте Service Account в Google Cloud Console и скачайте его JSON-ключ.</li>
        <li>Вставьте содержимое JSON-файла целиком ниже — он хранится в зашифрованном виде.</li>
        <li>
          Откройте нужную папку на Google Drive → <strong>Share</strong> → добавьте email сервисного
          аккаунта (поле <code>client_email</code> из JSON) с доступом Viewer.
        </li>
        <li>Укажите Folder ID папки (часть URL после <code>/folders/</code>) и синхронизируйте.</li>
      </ol>

      {!connected ? (
        <form onSubmit={handleSaveJson} style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
          <div className="field">
            <label htmlFor="drive-json">JSON-ключ сервисного аккаунта</label>
            <textarea
              id="drive-json"
              className="textarea"
              value={json}
              onChange={(e) => setJson(e.target.value)}
              placeholder='{"type": "service_account", "client_email": "...", ...}'
              rows={5}
              required
            />
          </div>
          {jsonError ? (
            <div className="alert alert-danger" role="alert">
              {jsonError}
            </div>
          ) : null}
          <button type="submit" className="btn btn-secondary" disabled={savingJson}>
            {savingJson ? "Сохраняем…" : "Сохранить ключ"}
          </button>
        </form>
      ) : (
        <>
          <div className="alert alert-info">
            Google Drive подключён. Ключ сохранён — можно синхронизировать папку.
          </div>
          <form onSubmit={handleSync} style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
            <div className="field">
              <label htmlFor="drive-folder-id">Folder ID</label>
              <input
                id="drive-folder-id"
                type="text"
                className="input"
                value={folderId}
                onChange={(e) => setFolderId(e.target.value)}
                placeholder="1AbCdEfGhIjKlMnOpQrStUvWxYz"
                required
              />
              <p className="field-hint">
                Один folder ID за раз, без вложенных подпапок. Повторная синхронизация обновит уже
                добавленные файлы, а не создаст дубли.
              </p>
            </div>
            {syncError ? (
              <div className="alert alert-danger" role="alert">
                {syncError}
              </div>
            ) : null}
            {syncSuccess ? (
              <div className="alert alert-info" role="status">
                {syncSuccess}
              </div>
            ) : null}
            <div style={{ display: "flex", gap: "0.6rem" }}>
              <button type="submit" className="btn btn-primary" disabled={syncing}>
                {syncing ? "Синхронизируем…" : "Синхронизировать папку"}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConnected(false)}>
                Заменить ключ
              </button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
