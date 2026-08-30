import Link from "next/link";
import { notFound } from "next/navigation";
import { getAuthenticatedUser, getRouteHandlerSupabaseClient } from "@/lib/supabase/server-client";
import { getProviderLabel, type ActiveAIProvider } from "@/lib/ai";
import { ProjectSubNav } from "@/components/projects/ProjectSubNav";

export const dynamic = "force-dynamic";

interface ProjectRow {
  id: string;
  name: string;
  active_ai_provider: ActiveAIProvider | null;
}

// Wraps every page under /projects/[projectId]/** (chat, documents, model,
// channels): verifies the project exists AND belongs to the signed-in
// user via the RLS-scoped session client (projects_select_own: auth.uid()
// = user_id) -- a project that doesn't exist and one that belongs to
// someone else are indistinguishable here (both resolve `data: null`),
// same 404-not-403 posture every app/api/projects/** route already uses
// (see lib/supabase/server-client.ts's verifyProjectOwnership() comment) --
// notFound() renders ../not-found.tsx, ONE SEGMENT UP (app/(app)/projects/
// not-found.tsx), never a same-segment sibling -- and depends on there
// being no `loading.tsx` at any ANCESTOR of this segment (there isn't).
// This segment ALSO has no `loading.tsx` of its own anymore (there used to
// be one, app/(app)/projects/[projectId]/loading.tsx) -- deleted because,
// while provably safe for THIS layout's own notFound() above, it turned
// out to be unsafe for notFound() calls thrown by DESCENDANT pages
// (chat/[conversationId]/page.tsx, channels/[conversationId]/page.tsx) --
// see app/(app)/projects/not-found.tsx's header comment (bug 3) for the
// full mechanism and why removing it was the right trade-off. Both of
// these verified live with two real users in both `next dev` and a
// production build: a real 404 status + the branded UI, not Next's
// generic built-in 404 with a bare 200. Because Next.js stops rendering
// the tree entirely when a layout calls notFound(), every nested page/layout under this one
// (chat/documents/model/channels) can safely assume the project exists and
// is owned without re-deriving that itself.
export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  const supabase = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(supabase);
  if (!user) return null;

  const { data, error } = await supabase
    .from("projects")
    .select("id, name, active_ai_provider")
    .eq("id", projectId)
    .maybeSingle<ProjectRow>();
  if (error) {
    console.error(`projects/[projectId]/layout.tsx: failed to load project ${projectId}:`, error.message);
  }
  if (!data) {
    notFound();
  }

  const activeProviderLabel = data.active_ai_provider ? (getProviderLabel(data.active_ai_provider) ?? data.active_ai_provider) : null;

  return (
    <div className="project-shell">
      <header className="project-header">
        <Link href="/projects" className="project-header-back">
          ← Мои проекты
        </Link>
        <div className="project-header-title-row">
          <h1 className="project-header-title">{data.name}</h1>
          <Link href={`/projects/${projectId}/model`} className={`badge ${activeProviderLabel ? "badge-success" : "badge-warning"}`}>
            Работает на: {activeProviderLabel ?? "модель не выбрана"}
          </Link>
        </div>
      </header>
      <ProjectSubNav projectId={projectId} />
      <div className="project-content">{children}</div>
    </div>
  );
}
