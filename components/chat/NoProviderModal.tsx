"use client";

// components/chat/NoProviderModal.tsx
//
// Triggered specifically by POST /api/chat's `422 { error: "no_credentials" }`
// (see ChatView.tsx's sendMessage -- distinct from the generic 500/other
// error handling, which keeps the existing retry-banner treatment).
// Deliberately minimal per explicit product decision: no onboarding
// wizard, just a short explanation and a link to /profile.

import { useEffect, useRef } from "react";
import Link from "next/link";

export function NoProviderModal({ onDismiss }: { onDismiss: () => void }) {
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
          У вашего аккаунта пока не настроен ни один AI-провайдер, поэтому ассистенту нечем отвечать.
          Добавьте свой API-ключ (OpenAI, Anthropic + Voyage или Gemini) в профиле и выберите его
          активным.
        </p>
        <div style={{ display: "flex", gap: "0.6rem", justifyContent: "flex-end", marginTop: "1.25rem" }}>
          <button ref={closeButtonRef} type="button" className="btn btn-ghost" onClick={onDismiss}>
            Позже
          </button>
          <Link href="/profile" className="btn btn-primary">
            Перейти в профиль
          </Link>
        </div>
      </div>
    </div>
  );
}
