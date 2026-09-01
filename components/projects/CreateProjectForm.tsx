"use client";

// components/projects/CreateProjectForm.tsx
//
// Creates a new project via POST /api/projects (name trimmed, 1..200
// chars, validated server-side regardless of this form's own client-side
// check). On success, navigates straight into the new project's /model
// page rather than just refreshing the /projects list in place -- a
// brand-new project has no active_ai_provider yet, and picking one is the
// actual next required step before its chat/documents pages are useful at
// all, so this is a deliberate nudge rather than leaving the user to
// discover /model on their own.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { postJson, retryAfterSuffix } from "../sources/request-helpers";
import { redirectToLogin } from "@/lib/ui/client-redirect";

interface CreateProjectResult {
  project: { id: string };
}

const MAX_NAME_LENGTH = 200;

export function CreateProjectForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const trimmed = name.trim();
    if (!trimmed) {
      setError("Введите название проекта.");
      return;
    }
    if (trimmed.length > MAX_NAME_LENGTH) {
      setError(`Название не может быть длиннее ${MAX_NAME_LENGTH} символов.`);
      return;
    }

    setPending(true);
    const result = await postJson<CreateProjectResult>("/api/projects", { name: trimmed });
    setPending(false);

    if (!result.ok) {
      if (result.kind === "unauthorized") {
        redirectToLogin();
        return;
      }
      setError(result.message + retryAfterSuffix(result.retryAfterMs));
      return;
    }

    setName("");
    router.push(`/projects/${result.data.project.id}/model`);
  }

  return (
    <form onSubmit={handleSubmit} className="source-form" aria-labelledby="create-project-heading">
      <div className="field">
        <label htmlFor="new-project-name">Название проекта</label>
        <input
          id="new-project-name"
          type="text"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="например, «Бот поддержки клиентов»"
          maxLength={MAX_NAME_LENGTH}
          required
        />
        <p className="field-hint">
          Проект — это отдельный набор документов, модель и (опционально) Telegram-бот. Создайте
          столько проектов, сколько нужно.
        </p>
      </div>
      {error ? (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      ) : null}
      <div>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Создаём…" : "Создать проект"}
        </button>
      </div>
    </form>
  );
}
