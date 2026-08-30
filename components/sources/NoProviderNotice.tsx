"use client";

// components/sources/NoProviderNotice.tsx
//
// Shown by every components/sources/*Form.tsx (and DocumentCard's Refresh
// button) instead of the generic red error banner when an ingest request
// comes back `422 { error: "no_credentials" }` -- i.e. the signed-in user
// has no active AI provider configured yet, or their active provider's
// stored credential(s) are missing (see lib/ai/index.ts's
// getAIProviders()). request-helpers.ts's normalizeResponse() surfaces this
// as its own SourceRequestFailure `kind: "no_credentials"` so callers don't
// have to re-parse the response body themselves.
//
// Deliberately an inline banner, not components/chat/NoProviderModal.tsx's
// full-screen modal: that modal's UX (interrupting an in-progress
// conversation, "Позже" to dismiss and keep chatting) fits a chat turn that
// just failed mid-stream. Adding a source is already a page dedicated to
// configuring integrations, not an ongoing task a full-screen overlay would
// be interrupting -- an inline banner with the same "go configure it, retrying
// won't help" message fits the form better without stealing focus from the
// rest of the "Добавить источник" card (e.g. the other tabs).
//
// PROJECTS PIVOT: links to THIS project's /projects/{projectId}/model
// picker rather than straight to /profile -- see
// components/chat/NoProviderModal.tsx's identical comment for why (the same
// 422 { error: "no_credentials" } can mean either "this project hasn't
// picked a provider yet" or "its picked provider's credential was deleted",
// and /model is the right first stop for both).

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
