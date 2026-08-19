// lib/ui/format.ts
//
// Small, pure, framework-agnostic display helpers shared by server and
// client components under app/**/. Deliberately has no dependency on
// lib/ai/ or lib/sources/ (nextjs-frontend does not import those directly,
// per CLAUDE.md's ownership boundaries) -- everything here operates on the
// plain string literals ("manual_upload" | "notion" | "url" |
// "google_drive", processing_status values) that already cross the wire
// in API responses / DB rows.

export type DocumentSourceType = "manual_upload" | "notion" | "url" | "google_drive";
export type ProcessingStatus = "pending" | "processing" | "ready" | "error";

/** Label for a document's own source-type badge (documents list). */
export function sourceTypeLabel(type: DocumentSourceType): string {
  switch (type) {
    case "manual_upload":
      return "Загруженный файл";
    case "notion":
      return "Notion";
    case "url":
      return "Публичный URL";
    case "google_drive":
      return "Google Drive";
  }
}

/**
 * Phrasing for a citation under a chat answer -- distinct per source type
 * per CLAUDE.md's exact wording ("на основе документа «X»" / "из
 * Notion-страницы «X»" / "со страницы по ссылке X" / "из файла Google
 * Drive «X»"). `ref` is the sourceRef (URL/page id/file id), only
 * meaningful (and only shown) for non-manual sources.
 */
export function citationLabel(
  type: DocumentSourceType,
  title: string,
  ref: string | null
): string {
  switch (type) {
    case "manual_upload":
      return `на основе документа «${title}»`;
    case "notion":
      return `из Notion-страницы «${title}»`;
    case "url":
      return `со страницы по ссылке ${ref ?? title}`;
    case "google_drive":
      return `из файла Google Drive «${title}»`;
  }
}

/** True if `ref` looks like an http(s) URL worth rendering as a real link. */
export function isLinkableRef(ref: string | null): ref is string {
  if (!ref) return false;
  try {
    const parsed = new URL(ref);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Best-effort deep link for a citation, per source type. `url` sources
 * already store the real, final URL as `sourceRef` (see lib/sources/url.ts)
 * so that's used as-is. `notion`/`google_drive` store a bare id (the
 * Notion page id / Drive file id, not a URL -- see those adapters'
 * `sourceRef` doc comments), so a canonical deep-link URL is constructed
 * from it; `manual_upload` has no external location at all (sourceRef is
 * always null for it), so this returns null and the UI shows plain text
 * instead of a link.
 */
export function sourceLinkHref(type: DocumentSourceType, ref: string | null): string | null {
  if (!ref) return null;
  switch (type) {
    case "url":
      return isLinkableRef(ref) ? ref : null;
    case "notion":
      return `https://www.notion.so/${ref.replace(/-/g, "")}`;
    case "google_drive":
      return `https://drive.google.com/file/d/${ref}/view`;
    case "manual_upload":
      return null;
  }
}

export function processingStatusLabel(status: ProcessingStatus): string {
  switch (status) {
    case "pending":
      return "В очереди";
    case "processing":
      return "Обрабатывается";
    case "ready":
      return "Готов к вопросам";
    case "error":
      return "Ошибка";
  }
}

const RELATIVE_UNITS: [number, Intl.RelativeTimeFormatUnit][] = [
  [60, "second"],
  [60, "minute"],
  [24, "hour"],
  [7, "day"],
  [4.345, "week"],
  [12, "month"],
  [Number.POSITIVE_INFINITY, "year"],
];

/**
 * "5 минут назад"-style relative time, computed once (server or client) --
 * callers that render this from a Server Component should pass the
 * formatted string down as a prop rather than recomputing it after
 * hydration, so the string never drifts between server render and client
 * mount (see components/sources/DocumentCard.tsx).
 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const diffSeconds = Math.round((then.getTime() - now.getTime()) / 1000);

  const rtf = new Intl.RelativeTimeFormat("ru", { numeric: "auto" });
  let unitIndex = 0;
  let value = diffSeconds;
  for (; unitIndex < RELATIVE_UNITS.length - 1; unitIndex++) {
    const [amount] = RELATIVE_UNITS[unitIndex];
    if (Math.abs(value) < amount) break;
    value = Math.trunc(value / amount);
  }
  const unit = RELATIVE_UNITS[unitIndex][1];
  return rtf.format(value, unit);
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Rough % similarity for display next to a source citation. */
export function formatSimilarity(similarity: number): string {
  return `${Math.round(similarity * 100)}%`;
}
