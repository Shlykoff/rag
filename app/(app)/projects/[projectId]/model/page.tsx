import { ModelPicker } from "@/components/projects/ModelPicker";

export const dynamic = "force-dynamic";

// Thin server shell -- all provider state is loaded client-side by
// ModelPicker via GET /api/projects/{projectId}/model, per this stage's
// boundary rule (see ProfileForm.tsx's identical convention). Ownership of
// `projectId` already verified by the parent [projectId]/layout.tsx.
export default async function ProjectModelPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  return (
    <div className="sources-page">
      <ModelPicker projectId={projectId} />
    </div>
  );
}
