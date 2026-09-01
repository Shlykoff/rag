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
// channels): verifies the project exists and belongs to the signed-in
// user via the RLS-scoped session client (auth.uid() = user_id) -- a
// project that doesn't exist and one that belongs to someone else are
// indistinguishable here (both resolve `data: null`), same 404-not-403
// posture every app/api/projects/** route already uses. notFound() renders
// ../not-found.tsx, one segment up -- see that file for why it can't live
// inside this segment instead, and for why there's deliberately no
// loading.tsx anywhere in this ancestry. Because Next.js stops rendering
// the tree when a layout calls notFound(), every nested page/layout under
// this one (chat/documents/model/channels) can assume the project exists
// and is owned without re-deriving that itself.
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
