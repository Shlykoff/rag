"use client";

// components/profile/ProviderKeyField.tsx
//
// One reusable "add/update/remove this provider's API key" field, used
// four times on /profile (openai, anthropic, voyage, gemini -- see
// ProfileForm.tsx). Mirrors components/sources/NotionForm.tsx's
// save-a-secret pattern (password-type input, cleared after save, never
// pre-filled from the server) but generalized to also support deleting a
// key, since /profile explicitly needs "add/update/remove" per provider
// (unlike NotionForm, which only ever replaces).
//
// The plaintext key never round-trips back from the server after a save --
// `configured` (a boolean) is the only thing this component ever receives
// about an already-stored key; the input always starts empty.
//
// A save can also auto-activate a provider server-side (see
// app/api/profile/ai-providers/route.ts POST's `activeProvider` in its
// response -- set when this was the key that completed a provider AND the
// user had no active provider yet). `onActiveProviderChange` propagates
// that up to ProfileForm so "Активный провайдер" reflects it immediately,
// without a full GET refetch.

import { useState, type FormEvent } from "react";
import { postJson, deleteJson, retryAfterSuffix } from "@/components/sources/request-helpers";
import { redirectToLogin } from "@/lib/ui/client-redirect";
import type { AIProviderCredentialType, ActiveAIProvider } from "./types";

export interface ProviderKeyFieldProps {
  provider: AIProviderCredentialType;
  label: string;
  configured: boolean;
  placeholder?: string;
  onConfiguredChange: (provider: AIProviderCredentialType, configured: boolean) => void;
  /** Called whenever a save response carries a non-null `activeProvider` -- see this file's header. Optional only so tests/stories that don't care about the active-provider section can omit it. */
  onActiveProviderChange?: (provider: ActiveAIProvider) => void;
}

export function ProviderKeyField({
  provider,
  label,
  configured,
  placeholder,
  onConfiguredChange,
  onActiveProviderChange,
}: ProviderKeyFieldProps) {
  const [editing, setEditing] = useState(!configured);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = `provider-key-${provider}`;

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!value.trim()) {
      setError("Введите API-ключ.");
      return;
    }
    setSaving(true);
    const result = await postJson<{ status: string; activeProvider: ActiveAIProvider | null }>(
      "/api/profile/ai-providers",
      { provider, apiKey: value.trim() }
    );
    setSaving(false);
    if (!result.ok) {
      if (result.kind === "unauthorized") {
        redirectToLogin();
        return;
      }
      setError(result.message + retryAfterSuffix(result.retryAfterMs));
      return;
    }
    setValue("");
    setEditing(false);
    onConfiguredChange(provider, true);
    if (result.data.activeProvider !== null) {
      onActiveProviderChange?.(result.data.activeProvider);
    }
  }

  async function handleDelete() {
    setError(null);
    setDeleting(true);
    const result = await deleteJson<{ status: string }>("/api/profile/ai-providers", { provider });
    setDeleting(false);
    if (!result.ok) {
      if (result.kind === "unauthorized") {
        redirectToLogin();
        return;
      }
      setError(result.message + retryAfterSuffix(result.retryAfterMs));
      return;
    }
    onConfiguredChange(provider, false);
    setEditing(true);
  }

  function handleCancelEdit() {
    setValue("");
    setError(null);
    setEditing(false);
  }

  return (
    <div className="provider-key-field">
      <div className="provider-key-field-header">
        <label htmlFor={inputId}>{label}</label>
        <span className={`badge ${configured ? "badge-success" : "badge-neutral"}`}>
          {configured ? "настроен" : "не настроен"}
        </span>
      </div>

      {editing ? (
        <form onSubmit={handleSave} style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.35rem" }}>
          <input
            id={inputId}
            type="password"
            className="input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder ?? "API-ключ"}
            autoComplete="off"
            required
            style={{ flex: "1 1 14rem" }}
          />
          <button type="submit" className="btn btn-secondary btn-sm" disabled={saving}>
            {saving ? "Сохраняем…" : "Сохранить"}
          </button>
          {configured ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleCancelEdit} disabled={saving}>
              Отмена
            </button>
          ) : null}
        </form>
      ) : (
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.35rem" }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>
            Изменить ключ
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={handleDelete} disabled={deleting}>
            {deleting ? "Удаляем…" : "Удалить"}
          </button>
        </div>
      )}

      {error ? (
        <p className="alert alert-danger" role="alert" style={{ marginTop: "0.4rem" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
