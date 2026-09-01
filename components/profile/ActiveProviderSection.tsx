// components/profile/ActiveProviderSection.tsx
//
// Read-only summary of which AI providers are fully configured at the
// account level -- no PUT call, no interactivity. Per-project picking
// (which provider a given project actually uses) lives on that project's
// own /projects/[projectId]/model screen
// (components/projects/ModelPicker.tsx) instead, since this account-level
// page has no single project id to act on.

import { PROVIDER_DISPLAY_INFO, PROVIDER_DISPLAY_ORDER } from "@/lib/ui/provider-metadata";
import type { ConfiguredFlags } from "./types";

export interface ActiveProviderSectionProps {
  configured: ConfiguredFlags;
}

export function ActiveProviderSection({ configured }: ActiveProviderSectionProps) {
  return (
    <fieldset className="provider-active-fieldset">
      <legend className="provider-section-title">Готовые к использованию провайдеры</legend>
      <p className="field-hint">
        Какой из подключённых провайдеров использует конкретный проект/бот, выбирается отдельно для
        каждого проекта — на странице «Модель» внутри самого проекта. Здесь только видно, какие ключи у
        вас на аккаунте полностью настроены.
      </p>
      <ul style={{ display: "flex", flexDirection: "column", gap: "0.4rem", marginTop: "0.6rem", listStyle: "none", padding: 0 }}>
        {PROVIDER_DISPLAY_ORDER.map((provider) => {
          const info = PROVIDER_DISPLAY_INFO[provider];
          const available = info.requiresCredentials.every((credential) => configured[credential]);
          return (
            <li key={provider} className="provider-active-option" style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <span className={`badge ${available ? "badge-success" : "badge-neutral"}`}>
                {available ? "готов" : "не настроен"}
              </span>
              <span>{info.label}</span>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
