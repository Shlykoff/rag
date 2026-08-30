import { getAuthenticatedUser, getRouteHandlerSupabaseClient } from "@/lib/supabase/server-client";
import { AddSourceForm } from "@/components/sources/AddSourceForm";
import { DocumentList, type DocumentRow } from "@/components/sources/DocumentList";

export const dynamic = "force-dynamic";

interface CredentialRow {
  source_type: "notion" | "google_drive";
}

// Project-scoped documents/sources screen (replaces the old flat
// /sources). Ownership of `projectId` already verified by the parent
// [projectId]/layout.tsx.
export default async function ProjectDocumentsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const supabase = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(supabase);
  if (!user) return null;

  const [documentsResult, credentialsResult] = await Promise.all([
    supabase
      .from("documents")
      .select("id, title, source_type, source_ref, last_synced_at, processing_status, processing_error, created_at")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false }),
    // RLS (source_credentials_select_own) scopes this to the caller's own
    // rows; source credentials stay account-level (not project-scoped),
    // only the source_type column is read here -- never the
    // ciphertext/nonce, per lib/sources/credentials.ts's own comment on
    // keeping decryption server-side-only.
    supabase.from("source_credentials").select("source_type").eq("user_id", user.id),
  ]);

  if (documentsResult.error) {
    console.error(`projects/[projectId]/documents: failed to load documents (${projectId}):`, documentsResult.error.message);
  }
  if (credentialsResult.error) {
    console.error("projects/[projectId]/documents: failed to load source credentials:", credentialsResult.error.message);
  }

  const credentialTypes = new Set(((credentialsResult.data ?? []) as CredentialRow[]).map((r) => r.source_type));

  return (
    <div className="sources-page">
      <header className="sources-page-header">
        <h1>Документы и источники</h1>
        <p className="field-hint">
          Загрузите файл или подключите Notion, публичный URL, папку Google Drive — все они проходят
          один и тот же конвейер обработки (разбиение на фрагменты + генерация embeddings), прежде чем
          станут доступны ассистенту этого проекта.
        </p>
      </header>

      <AddSourceForm
        projectId={projectId}
        hasNotionCredential={credentialTypes.has("notion")}
        hasGoogleDriveCredential={credentialTypes.has("google_drive")}
      />

      <section aria-labelledby="documents-heading" style={{ marginTop: "2rem" }}>
        <h2 id="documents-heading" style={{ fontSize: "1.05rem", marginBottom: "0.9rem" }}>
          Документы проекта
        </h2>
        <DocumentList projectId={projectId} documents={(documentsResult.data ?? []) as DocumentRow[]} />
      </section>
    </div>
  );
}
