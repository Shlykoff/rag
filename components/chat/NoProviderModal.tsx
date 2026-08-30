"use client";

// components/chat/NoProviderModal.tsx
//
// Triggered specifically by POST /api/chat's `422 { error: "no_credentials" }`
// (see ChatView.tsx's sendMessage -- distinct from the generic 500/other
// error handling, which keeps the existing retry-banner treatment).
// Deliberately minimal per explicit product decision: no onboarding
// wizard, just a short explanation and a link onward.
//
// PROJECTS PIVOT: links to this PROJECT's own /projects/{projectId}/model
// picker, not directly to the account-level /profile -- lib/ai/index.ts's
// getAIProviders() throws this exact 422 both when the project has no
// active_ai_provider chosen yet at all (the common case for a fresh
// project -- the actionable next step is picking one on /model) and when a
// specific credential the project points at was since deleted (the
// actionable step there is /profile) -- the model page itself is where a
// "nothing configured account-wide yet" state is explained and pointed at
// /profile (see ModelPicker.tsx), so linking there first is correct for
// both cases rather than guessing which one happened from this generic
// message alone.

import { useEffect, useRef } from "react";
import Link from "next/link";

export function NoProviderModal({ projectId, onDismiss }: { projectId: string; onDismiss: () => void }) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onDismiss();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onDismiss]);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onDismiss}>
      <div
        className="modal card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="no-provider-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="no-provider-modal-title" style={{ fontSize: "1.1rem" }}>
          Добавьте AI-провайдера
        </h2>
        <p className="field-hint" style={{ marginTop: "0.5rem" }}>
          У этого проекта пока не выбрана активная AI-модель (или подключённый ключ провайдера был
          удалён), поэтому ассистенту нечем отвечать. Выберите провайдера на странице модели проекта —
          если ещё ни один не подключён к аккаунту, оттуда можно перейти в профиль и добавить ключ.
        </p>
        <div style={{ display: "flex", gap: "0.6rem", justifyContent: "flex-end", marginTop: "1.25rem" }}>
          <button ref={closeButtonRef} type="button" className="btn btn-ghost" onClick={onDismiss}>
            Позже
          </button>
          <Link href={`/projects/${projectId}/model`} className="btn btn-primary">
            Выбрать модель
          </Link>
        </div>
      </div>
    </div>
  );
}
