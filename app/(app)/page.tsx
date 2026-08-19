import { getAuthenticatedUser, getRouteHandlerSupabaseClient } from "@/lib/supabase/server-client";
import { ChatView } from "@/components/chat/ChatView";

export const dynamic = "force-dynamic";

export default async function NewChatPage() {
  const supabase = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(supabase);
  // app/(app)/layout.tsx already redirects unauthenticated visitors before
  // this ever renders; the null-check here is just to satisfy the type
  // checker without re-implementing that redirect.
  if (!user) return null;

  const { count, error } = await supabase
    .from("documents")
    .select("id", { count: "exact", head: true })
    .eq("processing_status", "ready");
  if (error) {
    console.error("app/(app)/page.tsx: failed to check for ready documents:", error.message);
  }

  return <ChatView initialMessages={[]} hasDocuments={(count ?? 0) > 0} />;
}
