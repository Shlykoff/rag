import { Suspense } from "react";
import { getAuthenticatedUser, getRouteHandlerSupabaseClient } from "@/lib/supabase/server-client";
import { getProviderLabel, type ActiveAIProvider } from "@/lib/ai";
import { CreateProjectForm } from "@/components/projects/CreateProjectForm";
import { ProjectList } from "@/components/projects/ProjectList";
import type { ProjectListItem } from "@/components/projects/types";

export const dynamic = "force-dynamic";

interface ProjectRow {
  id: string;
  name: string;
  active_ai_provider: ActiveAIProvider | null;
  documents: { count: number }[];
}

interface TelegramIntegrationRow {
  project_id: string;
}

// /projects -- the landing page after login (see app/(app)/page.tsx's
// redirect here). Server Component doing a direct RLS-scoped Supabase read
// for its initial data, same "Server Components MAY query Supabase
// directly" convention the old app/(app)/sources/page.tsx already
// established (see CLAUDE.md's "Established conventions" for this stage) --
// mutations (create/rename/delete) go through app/api/projects/** from the
// client components below, which then router.refresh() this page.
//
// LOADING STATE, DELIBERATELY NOT A loading.tsx FILE (bug fix, see
// app/(app)/projects/not-found.tsx's header + git history for the full
// story): a `loading.tsx` at this segment (or at app/(app)/, one level up)
// creates an ANCESTOR React Suspense boundary that also wraps the sibling
// app/(app)/projects/[projectId]/** route tree -- and Next.js may flush
// that ancestor boundary's fallback (locking the HTTP response status at
// 200) BEFORE [projectId]/layout.tsx's own async ownership check has even
// run, making a real 404 status impossible for its notFound() call.
// Reproduced live: with app/(app)/loading.tsx and/or this segment's own
// loading.tsx present, a cross-user/nonexistent project id under
// /projects/{id}/** rendered the correct branded 404 UI but with a bare
// 200 status, in both `next dev` and a production build -- removing BOTH
// ancestor loading.tsx files (and this page's own) fixed the status code;
// keeping app/(app)/projects/[projectId]/loading.tsx itself (same segment
// as the layout that throws notFound(), wraps only ITS children, not the
// layout's own top-level logic) is fine and was verified compatible with a
// real 404. The fix here: get the same loading-skeleton UX back via a
// Suspense boundary declared INSIDE this page's own JSX instead of the
// loading.tsx file convention -- this is scoped to ProjectsPage's own
// subtree only, never applies to the sibling [projectId] route tree, so it
// can't reintroduce the same bug.
export default async function ProjectsPage() {
  const supabase = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(supabase);
  if (!user) return null;

  return (
    <div className="projects-page">
      <header className="projects-page-header">
        <h1>Мои проекты</h1>
        <p className="field-hint">
          Каждый проект — это свой набор документов, своя выбранная AI-модель и (по желанию) свой
          Telegram-бот. Начните здесь, затем откройте проект, чтобы загрузить документы и пообщаться с
          ассистентом.
        </p>
      </header>

      <section className="card" aria-labelledby="create-project-heading">
        <h2 id="create-project-heading" style={{ fontSize: "1.05rem", marginBottom: "0.9rem" }}>
          Новый проект
        </h2>
        <CreateProjectForm />
      </section>

      <section aria-labelledby="projects-list-heading">
        <h2 id="projects-list-heading" style={{ fontSize: "1.05rem", marginBottom: "0.9rem" }}>
          Все проекты
        </h2>
        <Suspense fallback={<ProjectGridSkeleton />}>
          <ProjectsListSection supabase={supabase} />
        </Suspense>
      </section>
    </div>
  );
}

async function ProjectsListSection({ supabase }: { supabase: Awaited<ReturnType<typeof getRouteHandlerSupabaseClient>> }) {
  const [projectsResult, telegramResult] = await Promise.all([
    supabase
      .from("projects")
      .select("id, name, active_ai_provider, documents(count)")
      .order("created_at", { ascending: false }),
    // RLS (channel_integrations_select_own) already scopes this to
    // projects the caller owns -- see that table's migration -- so no
    // explicit project_id filter is needed here beyond channel = telegram.
    supabase.from("channel_integrations").select("project_id").eq("channel", "telegram"),
  ]);

  if (projectsResult.error) {
    console.error("app/(app)/projects/page.tsx: failed to load projects:", projectsResult.error.message);
  }
  if (telegramResult.error) {
    console.error("app/(app)/projects/page.tsx: failed to load Telegram integrations:", telegramResult.error.message);
  }

  const telegramProjectIds = new Set(
    ((telegramResult.data ?? []) as TelegramIntegrationRow[]).map((row) => row.project_id)
  );

  const projects: ProjectListItem[] = ((projectsResult.data ?? []) as ProjectRow[]).map((row) => ({
    id: row.id,
    name: row.name,
    documentCount: row.documents?.[0]?.count ?? 0,
    activeAiProviderLabel: row.active_ai_provider ? (getProviderLabel(row.active_ai_provider) ?? row.active_ai_provider) : null,
    telegramConnected: telegramProjectIds.has(row.id),
  }));

  return <ProjectList projects={projects} />;
}

function ProjectGridSkeleton() {
  return (
    <div className="project-grid" aria-busy="true" aria-label="Загрузка проектов">
      {[0, 1, 2].map((i) => (
        <div key={i} className="card" style={{ height: "9rem" }}>
          <div className="skeleton" style={{ height: "100%", width: "100%" }} />
        </div>
      ))}
    </div>
  );
}
