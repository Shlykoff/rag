import { getRouteHandlerSupabaseClient } from "@/lib/supabase/server-client";
import { ChatView } from "@/components/chat/ChatView";

export const dynamic = "force-dynamic";

// New-conversation chat, scoped to this project. Ownership already
// verified by the parent [projectId]/layout.tsx.
export default async function ProjectNewChatPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const supabase = await getRouteHandlerSupabaseClient();

  const { count, error } = await supabase
    .from("documents")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("processing_status", "ready");
  if (error) {
    console.error(`projects/[projectId]/chat/page.tsx: failed to check for ready documents (${projectId}):`, error.message);
  }

  return <ChatView projectId={projectId} initialMessages={[]} hasDocuments={(count ?? 0) > 0} />;
}
