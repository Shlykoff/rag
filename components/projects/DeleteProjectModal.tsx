"use client";

// components/projects/DeleteProjectModal.tsx
//
// Real confirmation step in front of DELETE /api/projects/{projectId} --
// deliberately stronger than DocumentCard.tsx's "Точно удалить?" /
// "Да, удалить" two-click pattern, because a project delete has a much
// bigger blast radius: every document, chunk, and embedding; every Storage
// object under the project; the Telegram integration; and all chat history
// (owner and external), all irreversibly, in one request. Typing the exact
// project name back communicates that scope honestly, where a plain
// double-click confirm would not.

import { useEffect, useRef, useState } from "react";
import { matchesConfirmationText } from "@/lib/ui/format";
import { del } from "../sources/request-helpers";
import { redirectToLogin } from "@/lib/ui/client-redirect";

export interface DeleteProjectModalProps {
  projectId: string;
  projectName: string;
  onClose: () => void;
  onDeleted: () => void;
}

export function DeleteProjectModal({ projectId, projectName, onClose, onDeleted }: DeleteProjectModalProps) {
  const [confirmationText, setConfirmationText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const canDelete = matchesConfirmationText(confirmationText, projectName) && !pending;

  async function handleDelete() {
    if (!canDelete) return;
    setPending(true);
    setError(null);
    const result = await del<{ projectId: string; status: string }>(`/api/projects/${projectId}`);
    setPending(false);

    if (!result.ok) {
      if (result.kind === "unauthorized") {
        redirectToLogin();
        return;
      }
      if (result.kind === "not_found") {
        // Already gone (another tab, a concurrent delete) -- treat as
        // success from this modal's point of view rather than an error.
        onDeleted();
        return;
      }
      // Includes the documented `storage_cleanup_failed` 500 case -- the
      // project row is deliberately kept alive server-side on that failure
      // specifically so a retry (clicking "Удалить проект" again) can
      // succeed once the underlying Storage issue clears; surfaced here as
      // a real error banner, modal stays open so the user can retry without
      // re-typing the confirmation (confirmationText is left as-is).
      setError(result.message);
      return;
    }
    onDeleted();
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-project-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="delete-project-modal-title" style={{ fontSize: "1.1rem" }}>
          Удалить проект «{projectName}»?
        </h2>
        <p className="field-hint" style={{ marginTop: "0.5rem" }}>
          Это действие необратимо. Будут безвозвратно удалены: все документы и их фрагменты, все файлы
          в хранилище этого проекта, история переписки (включая диалоги внешних пользователей через
          Telegram, если бот подключён) и настройки Telegram-бота проекта.
        </p>
        <div className="field" style={{ marginTop: "0.9rem" }}>
          <label htmlFor="delete-project-confirm">
            Чтобы подтвердить, введите название проекта: <strong>{projectName}</strong>
          </label>
          <input
            id="delete-project-confirm"
            ref={inputRef}
            type="text"
            className="input"
            value={confirmationText}
            onChange={(e) => setConfirmationText(e.target.value)}
            autoComplete="off"
          />
        </div>
        {error ? (
          <div className="alert alert-danger" role="alert" style={{ marginTop: "0.75rem" }}>
            {error}
          </div>
        ) : null}
        <div style={{ display: "flex", gap: "0.6rem", justifyContent: "flex-end", marginTop: "1.25rem" }}>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={pending}>
            Отмена
          </button>
          <button type="button" className="btn btn-danger" onClick={handleDelete} disabled={!canDelete}>
            {pending ? "Удаляем…" : "Удалить проект"}
          </button>
        </div>
      </div>
    </div>
  );
}
