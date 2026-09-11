"use client";

// components/chat/NoProviderModal.tsx
//
// Triggered by POST /api/chat's `422 { error: "no_credentials" }` (see
// ChatView.tsx's sendMessage -- distinct from the generic 500/other error
// handling, which keeps the retry-banner treatment). Deliberately minimal:
// no onboarding wizard, just a short explanation and a link onward.
//
// Links to this project's model page, not straight to /profile: the 422
// fires both when a chat/embedding model isn't chosen yet and when the key
// for a chosen model was deleted, and the model page handles both (it
// links on to /profile when a key is missing).

import { useEffect, useRef } from "react";
import Link from "next/link";

export function NoProviderModal({ projectId, onDismiss }: { projectId: string; onDismiss: () => void }) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  // Latest `onDismiss` without being a dependency of the mount-only focus
  // effect below -- ChatView.tsx (the only current caller) passes a fresh
  // inline arrow function on every render, and this modal is rendered while
  // the chat textarea stays mounted behind it, so making that effect depend
  // on `onDismiss` directly re-ran it (and re-stole focus via
  // `closeButtonRef.current?.focus()`) on every keystroke, not just once on
  // mount. This separate effect just keeps the ref in sync -- writing to a
  // ref from inside an effect (not during render, per
  // react-hooks/refs -- refs may only be read/written outside of render)
  // is cheap and has no visible side effect of its own, so it re-running on
  // every `onDismiss` change is harmless; the focus-stealing effect below
  // reads `onDismissRef.current` instead of closing over `onDismiss`
  // directly, so it can stay mount-only ([] deps).
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    closeButtonRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onDismissRef.current();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

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
          Выберите модель проекта
        </h2>
        <p className="field-hint" style={{ marginTop: "0.5rem" }}>
          Ассистенту нечем ответить: у проекта не выбрана модель чата или модель эмбеддингов, либо из
          профиля удалён API-ключ провайдера выбранной модели. Откройте настройки модели проекта — там
          можно выбрать модели, а если нужного ключа нет, перейти в профиль и добавить его.
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
