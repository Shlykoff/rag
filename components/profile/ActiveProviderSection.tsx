// components/profile/ActiveProviderSection.tsx
//
// Read-only summary of the account's saved keys: which providers are
// connected, what each enables, and whether together they cover both the
// chat and the embedding model a project needs. Models themselves are
// picked per project (components/projects/ModelPicker.tsx).

import {
  ALL_PROVIDER_DISPLAY_ORDER,
  PROVIDER_LABELS,
  describeAccountReadiness,
  describeProviderCapabilities,
} from "@/lib/ui/provider-metadata";
import type { ConfiguredFlags } from "./types";

export interface ActiveProviderSectionProps {
  configured: ConfiguredFlags;
}

export function ActiveProviderSection({ configured }: ActiveProviderSectionProps) {
  const readiness = describeAccountReadiness(configured);
  return (
    <div>
      <h2 className="provider-section-title">Подключённые провайдеры</h2>
      <p className="field-hint">
        Конкретные модели выбираются в каждом проекте отдельно — на странице «Модель» внутри проекта. Там
        видны цены, размер контекста и размерность векторов каждой модели.
      </p>
      <ul style={{ display: "flex", flexDirection: "column", gap: "0.4rem", marginTop: "0.6rem" }}>
        {ALL_PROVIDER_DISPLAY_ORDER.map((provider) => {
          const available = configured[provider];
          return (
            <li key={provider} style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
              <span className={`badge ${available ? "badge-success" : "badge-neutral"}`}>
                {available ? "ключ сохранён" : "нет ключа"}
              </span>
              <span>{PROVIDER_LABELS[provider]}</span>
              <span className="field-hint">— {describeProviderCapabilities(provider)}</span>
            </li>
          );
        })}
      </ul>
      <p
        className={`alert ${readiness.chat && readiness.embedding ? "alert-info" : "alert-warning"}`}
        style={{ marginTop: "0.8rem" }}
      >
        {readiness.message}
      </p>
    </div>
  );
}
