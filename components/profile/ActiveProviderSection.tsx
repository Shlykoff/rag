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
// Downgraded, for this stage only, to a READ-ONLY summary of which
// providers are fully configured at the account level -- no PUT call, no
// interactivity, no `activeProvider` prop. A real per-project picker
// belongs on a future `/projects/[projectId]/model`-style screen
// (nextjs-frontend's next stage), not bolted onto this page against a
// made-up project id.

import type { ConfiguredFlags } from "./types";

export interface ActiveProviderSectionProps {
  configured: ConfiguredFlags;
}

interface ProviderSummary {
  key: string;
  label: string;
  available: boolean;
}

export function ActiveProviderSection({ configured }: ActiveProviderSectionProps) {
  const providers: ProviderSummary[] = [
    { key: "openai", label: "OpenAI", available: configured.openai },
    {
      key: "anthropic",
      label: "Anthropic Claude (+ Voyage AI для embeddings)",
      available: configured.anthropic && configured.voyage,
    },
    { key: "gemini", label: "Google Gemini", available: configured.gemini },
  ];

  return (
    <fieldset className="provider-active-fieldset">
      <legend className="provider-section-title">Готовые к использованию провайдеры</legend>
      <p className="field-hint">
        Какой из подключённых провайдеров использует конкретный проект/бот, теперь выбирается отдельно
        для каждого проекта (этот экран появится позже) — здесь только видно, какие ключи у вас на
        аккаунте полностью настроены.
      </p>
      <ul style={{ display: "flex", flexDirection: "column", gap: "0.4rem", marginTop: "0.6rem", listStyle: "none", padding: 0 }}>
        {providers.map((provider) => (
          <li key={provider.key} className="provider-active-option" style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <span className={`badge ${provider.available ? "badge-success" : "badge-neutral"}`}>
              {provider.available ? "готов" : "не настроен"}
            </span>
            <span>{provider.label}</span>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
