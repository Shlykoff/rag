import { formatRelativeTime } from "@/lib/ui/format";
import { DocumentCard } from "./DocumentCard";
import type { DocumentSourceType, ProcessingStatus } from "@/lib/ui/format";

export interface DocumentRow {
  id: string;
  title: string;
  source_type: DocumentSourceType;
  source_ref: string | null;
  last_synced_at: string | null;
  processing_status: ProcessingStatus;
  processing_error: string | null;
  created_at: string;
}

export function DocumentList({ projectId, documents }: { projectId: string; documents: DocumentRow[] }) {
  if (documents.length === 0) {
    return (
      <div className="card empty-state">
        <p>В этом проекте пока нет ни одного документа.</p>
        <p className="field-hint">
          Загрузите файл или подключите один из внешних источников выше, чтобы ассистент мог отвечать
          на вопросы по вашим данным.
        </p>
      </div>
    );
  }

  return (
    <ul className="document-list">
      {documents.map((doc) => (
        <li key={doc.id}>
          <DocumentCard
            projectId={projectId}
            documentId={doc.id}
            title={doc.title}
            sourceType={doc.source_type}
            sourceRef={doc.source_ref}
            processingStatus={doc.processing_status}
            processingError={doc.processing_error}
            lastSyncedLabel={doc.last_synced_at ? formatRelativeTime(doc.last_synced_at) : null}
          />
        </li>
      ))}
    </ul>
  );
}
