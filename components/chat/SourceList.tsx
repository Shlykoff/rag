import { citationLabel, formatSimilarity, sourceLinkHref } from "@/lib/ui/format";
import type { ContextSource } from "./types";

export function SourceList({ sources }: { sources: ContextSource[] }) {
  if (sources.length === 0) return null;

  return (
    <div className="source-list">
      <p className="source-list-title">Источники:</p>
      <ul>
        {sources.map((source) => {
          const label = citationLabel(source.sourceType, source.documentTitle, source.sourceRef);
          const href = sourceLinkHref(source.sourceType, source.sourceRef);
          const position =
            source.pageNumber != null
              ? `стр. ${source.pageNumber}`
              : source.chunkPosition != null
                ? `фрагмент ${source.chunkPosition + 1}`
                : null;

          return (
            <li key={source.chunkId} className="source-list-item">
              {href ? (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {label}
                </a>
              ) : (
                <span>{label}</span>
              )}
              {position ? <span className="badge badge-neutral">{position}</span> : null}
              <span className="badge badge-neutral" title="Похожесть на вопрос">
                {formatSimilarity(source.similarity)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
