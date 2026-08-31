"use client";

// components/projects/ModelPicker.tsx
//
// Reads/sets THIS project's `active_ai_provider` via
// GET/PUT /api/projects/{projectId}/model (see that route's own header for
// the exact contract) -- never lib/ai/credentials.ts directly, per this
// stage's boundary rule ("use client" components fetch from a dedicated
// /api/* route on mount, same as components/profile/ProfileForm.tsx's own
// header comment states explicitly).
//
// Three states worth calling out:
//   1. Nothing connected at the ACCOUNT level at all (every `configured`
//      flag false) -- the picker has literally nothing to offer, so this
//      renders a dedicated "connect a provider first" banner pointing at
//      /profile instead of an empty/all-disabled radio list a user would
//      have to guess the meaning of.
//   2. Some providers connected, none usable for a specific pick (e.g. only
//      an 'anthropic' key without the paired 'voyage' one) -- that option
//      renders visibly but disabled, with its own short "чего не хватает"
//      hint (mirrors ActiveProviderSection.tsx's pre-pivot styling
//      conventions, .model-option-unavailable/.badge-neutral).
//   3. PUT's `400 { error: "missing_credentials" }` race (e.g. the owner
//      deleted a credential in another tab between this page's load and the
//      click) -- surfaced as a real inline error with the server's own
//      actionable message + a link to /profile, never a raw error dump.

import { useEffect, useState } from "react";
import Link from "next/link";
import { redirectToLogin } from "@/lib/ui/client-redirect";
import { getJson, putJson } from "@/components/sources/request-helpers";
import { PROVIDER_DISPLAY_INFO, PROVIDER_DISPLAY_ORDER } from "@/lib/ui/provider-metadata";
// Type-only import -- lib/ai/index.ts transitively re-exports from
// lib/ai/credentials.ts, which is `import "server-only"`-tagged; a runtime
// (value) import of anything from "@/lib/ai" here would pull that into
// this "use client" bundle and fail the build. Type-only imports are
// erased at compile time (same pattern components/profile/types.ts already
// documents for itself). Display labels/required-credentials themselves now
// live in lib/ui/provider-metadata.ts (client-safe, imported above) rather
// than being duplicated locally.
import type { ActiveAIProvider, AIProviderCredentialType } from "@/lib/ai";

type ConfiguredFlags = Record<AIProviderCredentialType, boolean>;

interface GetResponseBody {
  activeProvider: ActiveAIProvider | null;
  configured: ConfiguredFlags;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; activeProvider: ActiveAIProvider | null; configured: ConfiguredFlags };

async function fetchModelState(projectId: string): Promise<LoadState> {
  const result = await getJson<GetResponseBody>(`/api/projects/${projectId}/model`);
  if (!result.ok) {
    if (result.kind === "unauthorized") {
      redirectToLogin();
      return { status: "loading" };
    }
    if (result.kind === "not_found") {
      return { status: "error", message: "Проект не найден — возможно, он был удалён в другой вкладке." };
    }
    return { status: "error", message: result.message };
  }
  return { status: "ready", activeProvider: result.data.activeProvider, configured: result.data.configured };
}

export function ModelPicker({ projectId }: { projectId: string }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [saving, setSaving] = useState<ActiveAIProvider | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchModelState(projectId).then((result) => {
      if (!cancelled) setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  function handleRetry() {
    setState({ status: "loading" });
    void fetchModelState(projectId).then((result) => setState(result));
  }

  if (state.status === "loading") {
    return <ModelPickerSkeleton />;
  }

  if (state.status === "error") {
    return (
      <div className="card empty-state" role="alert">
        <p>{state.message}</p>
        <div>
          <button type="button" className="btn btn-secondary" onClick={handleRetry}>
            Попробовать снова
          </button>
        </div>
      </div>
    );
  }

  const { activeProvider, configured } = state;
  const nothingConfiguredAtAll = !configured.openai && !configured.anthropic && !configured.gemini && !configured.voyage;

  async function handleSelect(provider: ActiveAIProvider) {
    if (provider === activeProvider || saving) return;
    setSaving(provider);
    setSaveError(null);
    const result = await putJson<{ provider: ActiveAIProvider }>(`/api/projects/${projectId}/model`, { provider });
    setSaving(null);
    if (!result.ok) {
      if (result.kind === "unauthorized") {
        redirectToLogin();
        return;
      }
      // Covers the `400 { error: "missing_credentials" }` race (e.g. the
      // owner deleted a credential in another tab between this page's load
      // and the click) the same way the pre-refactor inline handling did --
      // normalizeResponse's describeErrorBody() already prefers the
      // server's own `message` when present (which this route's contract
      // always sets for missing_credentials -- see this file's own header
      // comment), so no separate branch on `result.code` is needed here.
      setSaveError(result.message);
      return;
    }
    setState((prev) => (prev.status === "ready" ? { ...prev, activeProvider: provider } : prev));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <section className="card">
        <h1 style={{ fontSize: "1.05rem", marginBottom: "0.4rem" }}>Модель проекта</h1>
        <p className="field-hint">
          Сейчас активна:{" "}
          <strong>
            {activeProvider ? (PROVIDER_DISPLAY_INFO[activeProvider]?.label ?? activeProvider) : "модель ещё не выбрана"}
          </strong>
        </p>
      </section>

      {nothingConfiguredAtAll ? (
        <div className="alert alert-danger" role="alert">
          <p style={{ margin: 0 }}>
            К вашему аккаунту пока не подключён ни один AI-провайдер, поэтому выбирать здесь пока не из
            чего. Сначала добавьте API-ключ хотя бы одного провайдера в профиле.
          </p>
          <Link href="/profile" className="btn btn-primary btn-sm" style={{ marginTop: "0.6rem", display: "inline-block" }}>
            Перейти в профиль
          </Link>
        </div>
      ) : (
        <fieldset className="card" style={{ display: "flex", flexDirection: "column", gap: "0.7rem" }}>
          <legend className="provider-section-title">Выберите провайдера для этого проекта</legend>
          {PROVIDER_DISPLAY_ORDER.map((providerId) => {
            const info = PROVIDER_DISPLAY_INFO[providerId];
            const available = info.requiresCredentials.every((req) => configured[req]);
            const isActive = activeProvider === providerId;
            const missing = info.requiresCredentials.filter((req) => !configured[req]);
            return (
              <label
                key={providerId}
                className={`model-option${isActive ? " model-option-active" : ""}${!available ? " model-option-unavailable" : ""}`}
              >
                <input
                  type="radio"
                  name="active-provider"
                  value={providerId}
                  checked={isActive}
                  disabled={!available || saving !== null}
                  onChange={() => handleSelect(providerId)}
                />
                <div className="model-option-main">
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                    <span>{info.label}</span>
                    {isActive ? <span className="badge badge-success">активна</span> : null}
                    {!available ? <span className="badge badge-neutral">не настроен</span> : null}
                    {saving === providerId ? <span className="spinner" aria-hidden="true" /> : null}
                  </div>
                  {!available ? (
                    <p className="field-hint" style={{ marginTop: "0.3rem" }}>
                      Не хватает ключа: {missing.join(", ")}. Добавьте{" "}
                      <Link href="/profile" style={{ textDecoration: "underline" }}>
                        в профиле
                      </Link>
                      .
                    </p>
                  ) : null}
                </div>
              </label>
            );
          })}
          {saveError ? (
            <div className="alert alert-danger" role="alert">
              {saveError}
            </div>
          ) : null}
        </fieldset>
      )}
    </div>
  );
}

function ModelPickerSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }} aria-busy="true" aria-label="Загрузка настроек модели">
      {[0, 1].map((i) => (
        <div key={i} className="card" style={{ height: "6rem" }}>
          <div className="skeleton" style={{ height: "100%", width: "100%" }} />
        </div>
      ))}
    </div>
  );
}
