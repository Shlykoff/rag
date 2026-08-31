// components/profile/ActiveProviderSection.tsx
//
// PROJECTS PIVOT DAMAGE CONTROL (see app/api/profile/ai-providers/route.ts's
// own PROJECTS PIVOT NOTE for the full story): this used to be an
// interactive radio picker for `user_settings.active_ai_provider`, calling
// `PUT /api/profile/ai-providers`. That endpoint is gone -- "which provider
// is active" moved to a per-PROJECT selection (`projects.active_ai_provider`),
// which needs an actual `projectId` this account-level page doesn't have.
// Live-reproduced regression this fixes: with the old interactive version
// left in place, clicking a radio option hit the now-405'd `PUT` and showed
// a raw `"Не удалось выполнить запрос (405)."` banner, and the radio group
// always rendered with nothing selected anyway (the old `GET`'s
// `activeProvider` field is gone too, see ProfileForm.tsx).
//
// Downgraded to a READ-ONLY summary of which providers are fully configured
// at the account level -- no PUT call, no interactivity, no
// `activeProvider` prop. Per-project picking now lives on each project's
// own /projects/[projectId]/model screen (components/projects/ModelPicker.tsx)
// -- not bolted onto this account-level page, which has no single project
// id to act on.

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
