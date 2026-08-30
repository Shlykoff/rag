import { redirect } from "next/navigation";

// Bare /projects/{projectId} (e.g. a bookmarked/pasted link with no
// section) -- redirects to the project's chat, its default section. The
// parent layout has already verified project ownership (notFound() there
// if not) before this ever renders, so this can redirect unconditionally.
export default async function ProjectRootPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  redirect(`/projects/${projectId}/chat`);
}
