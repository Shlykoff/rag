"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { processingStatusLabel, sourceLinkHref, sourceTypeLabel } from "@/lib/ui/format";
import type { DocumentSourceType, ProcessingStatus } from "@/lib/ui/format";
import { del, postEmpty, retryAfterSuffix } from "./request-helpers";
import { redirectToLogin } from "@/lib/ui/client-redirect";
import { NoProviderNotice } from "./NoProviderNotice";

export interface DocumentCardProps {
  /** Only needed to build the /projects/{projectId}/model link inside NoProviderNotice on a 422 refresh failure -- the refresh/delete requests themselves don't need it (ownership is derived from the document row server-side). */
  projectId: string;
  documentId: string;
  title: string;
  sourceType: DocumentSourceType;
  sourceRef: string | null;
  processingStatus: ProcessingStatus;
  processingError: string | null;
  /** Pre-formatted ("5 минут назад") on the server -- see DocumentList's doc comment on why this isn't recomputed client-side. */
  lastSyncedLabel: string | null;
}

// How long the "точно удалить?" confirmation stays armed before silently
// reverting to the plain "Удалить" button -- long enough to read and react,
// short enough that walking away from the tab doesn't leave a live
// destructive action sitting one accidental click away.
const DELETE_CONFIRM_TIMEOUT_MS = 5000;

function statusBadgeClass(status: ProcessingStatus): string {
  switch (status) {
    case "ready":
      return "badge-success";
    case "error":
      return "badge-danger";
    case "processing":
    case "pending":
      return "badge-warning";
  }
}

export function DocumentCard({
  projectId,
  documentId,
  title,
  sourceType,
  sourceRef,
  processingStatus,
  processingError,
  lastSyncedLabel,
}: DocumentCardProps) {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // Set instead of refreshError on a 422 { error: "no_credentials" }
  // response -- see UploadForm.tsx's identical field comment.
  const [refreshNoProviderMessage, setRefreshNoProviderMessage] = useState<string | null>(null);

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const confirmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
    };
  }, []);

  const canRefresh = sourceType !== "manual_upload";
  const href = sourceLinkHref(sourceType, sourceRef);

  async function handleRefresh() {
    setRefreshing(true);
    setRefreshError(null);
    setRefreshNoProviderMessage(null);
    const result = await postEmpty<{ documentId: string; chunkCount: number; status: string }>(
      `/api/sources/${documentId}/refresh`
    );
    setRefreshing(false);
    if (!result.ok) {
      if (result.kind === "unauthorized") {
        redirectToLogin();
        return;
      }
      if (result.kind === "no_credentials") {
        setRefreshNoProviderMessage(result.message);
        return;
      }
      setRefreshError(result.message + retryAfterSuffix(result.retryAfterMs));
      return;
    }
    router.refresh();
  }

  function handleDeleteClick() {
    setDeleteError(null);
    setConfirmingDelete(true);
    if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
    confirmTimeoutRef.current = setTimeout(() => {
      setConfirmingDelete(false);
    }, DELETE_CONFIRM_TIMEOUT_MS);
  }

  function handleCancelDelete() {
    if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
    setConfirmingDelete(false);
  }

  async function handleConfirmDelete() {
    if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
    setDeleting(true);
    setDeleteError(null);
    const result = await del<{ documentId: string; status: string }>(`/api/sources/${documentId}`);
    setDeleting(false);
    setConfirmingDelete(false);
    if (!result.ok) {
      if (result.kind === "unauthorized") {
        redirectToLogin();
        return;
      }
      if (result.kind === "not_found") {
        // Race condition, not a real failure: someone/something already
        // removed this document (another tab, a concurrent delete). Refresh
        // the list so it disappears -- no scary error for the user.
        router.refresh();
        return;
      }
      setDeleteError(result.message + retryAfterSuffix(result.retryAfterMs));
      return;
    }
    router.refresh();
  }

  return (
    <div className="card document-card">
      <div className="document-card-main">
        <div className="document-card-title-row">
          <h3 className="document-card-title">{title}</h3>
          <span className={`badge ${statusBadgeClass(processingStatus)}`}>
            {processingStatus === "processing" || processingStatus === "pending" ? (
              <span className="spinner" aria-hidden="true" />
            ) : null}
            {processingStatusLabel(processingStatus)}
          </span>
        </div>
        <div className="document-card-meta">
          <span className="badge badge-neutral">{sourceTypeLabel(sourceType)}</span>
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer" className="field-hint">
              открыть источник
            </a>
          ) : null}
          {lastSyncedLabel ? <span className="field-hint">синхронизировано {lastSyncedLabel}</span> : null}
        </div>
        {processingStatus === "error" && processingError ? (
          <p className="alert alert-danger" style={{ marginTop: "0.5rem" }} role="alert">
            {processingError}
          </p>
        ) : null}
        {refreshNoProviderMessage ? (
          <div style={{ marginTop: "0.5rem" }}>
            <NoProviderNotice projectId={projectId} message={refreshNoProviderMessage} />
          </div>
        ) : null}
        {refreshError ? (
          <p className="alert alert-danger" style={{ marginTop: "0.5rem" }} role="alert">
            {refreshError}
          </p>
        ) : null}
        {deleteError ? (
          <p className="alert alert-danger" style={{ marginTop: "0.5rem" }} role="alert">
            {deleteError}
          </p>
        ) : null}
      </div>
      <div className="document-card-actions">
        {canRefresh ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={handleRefresh} disabled={refreshing || deleting}>
            {refreshing ? "Обновляем…" : "Refresh"}
          </button>
        ) : null}
        {confirmingDelete ? (
          <span className="document-card-delete-confirm" role="group" aria-label={`Подтвердите удаление документа «${title}»`}>
            <span className="field-hint">Точно удалить?</span>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={handleConfirmDelete}
              disabled={deleting || refreshing}
            >
              {deleting ? (
                <>
                  <span className="spinner" aria-hidden="true" /> Удаляем…
                </>
              ) : (
                "Да, удалить"
              )}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={handleCancelDelete}
              disabled={deleting || refreshing}
            >
              Отмена
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={handleDeleteClick}
            disabled={deleting || refreshing}
            aria-label={`Удалить документ «${title}»`}
          >
            Удалить
          </button>
        )}
      </div>
    </div>
  );
}
