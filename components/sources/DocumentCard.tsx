"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { processingStatusLabel, sourceLinkHref, sourceTypeLabel } from "@/lib/ui/format";
import type { DocumentSourceType, ProcessingStatus } from "@/lib/ui/format";
import { postEmpty, retryAfterSuffix } from "./request-helpers";
import { redirectToLogin } from "@/lib/ui/client-redirect";

export interface DocumentCardProps {
  documentId: string;
  title: string;
  sourceType: DocumentSourceType;
  sourceRef: string | null;
  processingStatus: ProcessingStatus;
  processingError: string | null;
  /** Pre-formatted ("5 минут назад") on the server -- see DocumentList's doc comment on why this isn't recomputed client-side. */
  lastSyncedLabel: string | null;
}

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

  const canRefresh = sourceType !== "manual_upload";
  const href = sourceLinkHref(sourceType, sourceRef);

  async function handleRefresh() {
    setRefreshing(true);
    setRefreshError(null);
    const result = await postEmpty<{ documentId: string; chunkCount: number; status: string }>(
      `/api/sources/${documentId}/refresh`
    );
    setRefreshing(false);
    if (!result.ok) {
      if (result.kind === "unauthorized") {
        redirectToLogin();
        return;
      }
      setRefreshError(result.message + retryAfterSuffix(result.retryAfterMs));
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
        {refreshError ? (
          <p className="alert alert-danger" style={{ marginTop: "0.5rem" }} role="alert">
            {refreshError}
          </p>
        ) : null}
      </div>
      {canRefresh ? (
        <button type="button" className="btn btn-secondary btn-sm" onClick={handleRefresh} disabled={refreshing}>
          {refreshing ? "Обновляем…" : "Refresh"}
        </button>
      ) : null}
    </div>
  );
}
