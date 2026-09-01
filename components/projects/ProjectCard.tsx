"use client";

// components/projects/ProjectCard.tsx
//
// One project's card on /projects: name (links into its chat), at-a-glance
// badges (document count, active model, Telegram connection), rename
// (inline, PATCH), delete (DeleteProjectModal.tsx's typed confirmation,
// DELETE). Mirrors components/sources/DocumentCard.tsx's shape: a "use
// client" leaf that owns its own mutation state and calls router.refresh()
// on success so the Server Component parent (app/(app)/projects/page.tsx)
// re-fetches fresh data, rather than the list holding its own client
// state.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { patchJson, retryAfterSuffix } from "../sources/request-helpers";
import { redirectToLogin } from "@/lib/ui/client-redirect";
import { DeleteProjectModal } from "./DeleteProjectModal";
import type { ProjectListItem } from "./types";

interface RenameResult {
  project: { id: string; name: string };
}

const MAX_NAME_LENGTH = 200;

export function ProjectCard({ project }: { project: ProjectListItem }) {
  const router = useRouter();

  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(project.name);
  const [savingName, setSavingName] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  const [showDeleteModal, setShowDeleteModal] = useState(false);

  function startRename() {
    setNameDraft(project.name);
    setRenameError(null);
    setRenaming(true);
  }

  function cancelRename() {
    setRenaming(false);
    setRenameError(null);
  }

  async function handleRenameSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = nameDraft.trim();
    if (!trimmed) {
      setRenameError("Название не может быть пустым.");
      return;
    }
    if (trimmed.length > MAX_NAME_LENGTH) {
      setRenameError(`Название не может быть длиннее ${MAX_NAME_LENGTH} символов.`);
      return;
    }
    setSavingName(true);
    setRenameError(null);
    const result = await patchJson<RenameResult>(`/api/projects/${project.id}`, { name: trimmed });
    setSavingName(false);
    if (!result.ok) {
      if (result.kind === "unauthorized") {
        redirectToLogin();
        return;
      }
      if (result.kind === "not_found") {
        router.refresh();
        return;
      }
      setRenameError(result.message + retryAfterSuffix(result.retryAfterMs));
      return;
    }
    setRenaming(false);
    router.refresh();
  }

  function handleDeleted() {
    setShowDeleteModal(false);
    router.refresh();
  }

  return (
    <div className="card project-card">
      {renaming ? (
        <form onSubmit={handleRenameSubmit} className="project-card-rename-form">
          <label htmlFor={`rename-${project.id}`} className="visually-hidden">
            Новое название проекта
          </label>
          <input
            id={`rename-${project.id}`}
            type="text"
            className="input"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            maxLength={MAX_NAME_LENGTH}
            autoFocus
            required
          />
          <button type="submit" className="btn btn-primary btn-sm" disabled={savingName}>
            {savingName ? "…" : "Сохранить"}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={cancelRename} disabled={savingName}>
            Отмена
          </button>
        </form>
      ) : (
        <div className="project-card-title-row">
          <Link href={`/projects/${project.id}/chat`} className="project-card-title">
            {project.name}
          </Link>
          <button type="button" className="btn btn-ghost btn-sm" onClick={startRename} aria-label={`Переименовать проект «${project.name}»`}>
            Переименовать
          </button>
        </div>
      )}
      {renameError ? (
        <div className="alert alert-danger" role="alert">
          {renameError}
        </div>
      ) : null}

      <div className="project-card-meta">
        <span className="badge badge-neutral">
          {project.documentCount} {documentWord(project.documentCount)}
        </span>
        <Link href={`/projects/${project.id}/model`} className={`badge ${project.activeAiProviderLabel ? "badge-success" : "badge-warning"}`}>
          {project.activeAiProviderLabel ?? "модель не выбрана"}
        </Link>
        <Link href={`/projects/${project.id}/channels`} className={`badge ${project.telegramConnected ? "badge-success" : "badge-neutral"}`}>
          {project.telegramConnected ? "Telegram подключён" : "Telegram не подключён"}
        </Link>
      </div>

      <div className="project-card-actions">
        <Link href={`/projects/${project.id}/chat`} className="btn btn-primary btn-sm">
          Открыть чат
        </Link>
        <Link href={`/projects/${project.id}/documents`} className="btn btn-secondary btn-sm">
          Документы
        </Link>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowDeleteModal(true)}>
          Удалить
        </button>
      </div>

      {showDeleteModal ? (
        <DeleteProjectModal
          projectId={project.id}
          projectName={project.name}
          onClose={() => setShowDeleteModal(false)}
          onDeleted={handleDeleted}
        />
      ) : null}
    </div>
  );
}

function documentWord(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "документ";
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "документа";
  return "документов";
}
