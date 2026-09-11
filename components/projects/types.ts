// components/projects/types.ts
//
// Shared view-model type for the /projects list, one level richer than
// app/api/projects/shared.ts's wire-level ProjectDTO: this page is
// server-rendered via a direct RLS-scoped Supabase query (see
// app/(app)/projects/page.tsx), not a client-side fetch of GET
// /api/projects, so it adds `telegramConnected`, which that route doesn't
// return, computed server-side.

export interface ProjectListItem {
  id: string;
  name: string;
  documentCount: number;
  /** Display name of the project's chat model; null until one is chosen. */
  chatModelName: string | null;
  telegramConnected: boolean;
}
