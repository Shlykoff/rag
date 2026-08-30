"use client";

// components/projects/ProjectSubNav.tsx
//
// Tab-style nav between one project's four sections (Chat/Documents/
// Model/Channels), rendered by app/(app)/projects/[projectId]/layout.tsx
// above every page in this route subtree. "use client" purely for
// usePathname()-based active-tab highlighting -- the same
// server-can't-know-which-child-route-is-active constraint that made the
// old components/layout/Sidebar.tsx a client component too (see that
// file's own former comment on react-hooks/set-state-in-effect, N/A here
// since this component has no state of its own to set). The actual
// pathname -> active-tab derivation is a pure function
// (lib/ui/project-nav.ts's resolveActiveProjectTab), unit-tested there
// without needing to render this component at all.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { resolveActiveProjectTab, type ProjectSubNavTab } from "@/lib/ui/project-nav";

const TABS: { id: ProjectSubNavTab; label: string }[] = [
  { id: "chat", label: "Чат" },
  { id: "documents", label: "Документы" },
  { id: "model", label: "Модель" },
  { id: "channels", label: "Каналы" },
];

export function ProjectSubNav({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const activeTab = resolveActiveProjectTab(pathname, projectId);

  return (
    <nav className="project-subnav" aria-label="Разделы проекта">
      {TABS.map((tab) => (
        <Link
          key={tab.id}
          href={`/projects/${projectId}/${tab.id}`}
          className={`project-subnav-link${activeTab === tab.id ? " project-subnav-link-active" : ""}`}
          aria-current={activeTab === tab.id ? "page" : undefined}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
