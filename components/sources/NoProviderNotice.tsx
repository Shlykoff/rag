"use client";

// components/sources/NoProviderNotice.tsx
//
// Shown by every components/sources/*Form.tsx (and DocumentCard's Refresh
// button) instead of the generic red error banner when an ingest request
// comes back `422 { error: "no_credentials" }` -- the signed-in user has
// no active AI provider configured yet, or their active provider's stored
// credential(s) are missing. request-helpers.ts's normalizeResponse()
// surfaces this as its own SourceRequestFailure `kind: "no_credentials"`
// so callers don't have to re-parse the response body themselves.
//
// Deliberately an inline banner, not components/chat/NoProviderModal.tsx's
// full-screen modal: that modal's UX (interrupting an in-progress
// conversation, "Позже" to dismiss and keep chatting) fits a chat turn
// that just failed mid-stream. Adding a source is already a dedicated
// integrations page, not an ongoing task an overlay would interrupt -- an
// inline banner with the same "go configure it, retrying won't help"
// message fits the form better, without stealing focus from the rest of
// the "Добавить источник" card.
//
// Links to this project's own /projects/{projectId}/model picker rather
// than straight to /profile -- see NoProviderModal.tsx's identical comment
// for why (/model is the right first stop whether the project hasn't
// picked a provider yet, or its picked provider's credential was deleted).

import Link from "next/link";

export function NoProviderNotice({ projectId, message }: { projectId: string; message: string }) {
  return (
    <div className="alert alert-danger" role="alert">
      <p style={{ margin: 0 }}>{message}</p>
      <Link
        href={`/projects/${projectId}/model`}
        className="btn btn-primary btn-sm"
        style={{ marginTop: "0.6rem", display: "inline-block" }}
      >
        Выбрать модель проекта
      </Link>
    </div>
  );
}
