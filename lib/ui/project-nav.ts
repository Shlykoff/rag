// lib/ui/project-nav.ts
//
// Pure route -> active-tab resolution for
// components/projects/ProjectSubNav.tsx, extracted so the "which tab is
// highlighted" logic is unit-testable without rendering anything
// (usePathname() itself can't be invoked from a plain vitest test). Mirrors
// this project's existing convention of keeping pure display/derivation
// logic in lib/ui/ (see format.ts) separate from the "use client"
// components that call it.

export type ProjectSubNavTab = "chat" | "documents" | "model" | "channels";

const TAB_SEGMENTS: readonly ProjectSubNavTab[] = ["chat", "documents", "model", "channels"];

/**
 * Given the current pathname and a projectId, returns which sub-nav tab
 * (if any) should render as active. Matches by the first path segment
 * after `/projects/{projectId}/` rather than exact equality, so a nested
 * route -- e.g. `/projects/{id}/chat/{conversationId}` or
 * `/projects/{id}/channels/{conversationId}` -- still highlights its
 * parent tab ("chat" / "channels" respectively).
 */
export function resolveActiveProjectTab(pathname: string, projectId: string): ProjectSubNavTab | null {
  const prefix = `/projects/${projectId}/`;
  if (!pathname.startsWith(prefix)) return null;
  const firstSegment = pathname.slice(prefix.length).split("/")[0];
  return TAB_SEGMENTS.find((tab) => tab === firstSegment) ?? null;
}
