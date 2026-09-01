import { getAuthenticatedUser, getRouteHandlerSupabaseClient } from "@/lib/supabase/server-client";
import { ProfileForm } from "@/components/profile/ProfileForm";

export const dynamic = "force-dynamic";

// app/(app)/layout.tsx already redirects unauthenticated visitors before
// this renders; the check here is defense-in-depth, consistent with every
// other page in this route group. Unlike the documents page, this page
// does no server-side data fetch of its own -- provider state is loaded
// client-side by ProfileForm via GET /api/profile/ai-providers, never via
// lib/ai/credentials.ts directly (see ProfileForm.tsx).
export default async function ProfilePage() {
  const supabase = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(supabase);
  if (!user) return null;

  return (
    <div className="sources-page">
      <header className="sources-page-header">
        <h1>AI-провайдер</h1>
        <p className="field-hint">
          Добавьте свой API-ключ хотя бы одного AI-провайдера и выберите, какой из них использовать для
          чата и поиска по документам. Ключи хранятся в зашифрованном виде и никогда не показываются
          повторно после сохранения — если нужно проверить или заменить ключ, придётся ввести его заново.
        </p>
      </header>
      <ProfileForm />
    </div>
  );
}
