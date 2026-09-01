// components/layout/TopBar.tsx
//
// Account-level app shell nav, rendered by app/(app)/layout.tsx. Only
// three things every page under app/(app)/** shares regardless of which
// project (if any) is open: a way back to "Мои проекты", a way to
// account-level "Профиль", and who's signed in / sign out. Conversation
// history is scoped inside a project's own chat section instead (see
// components/chat/ChatHistoryPanel.tsx).
//
// A plain Server Component -- no interactive state of its own beyond the
// already-client SignOutButton, so no usePathname()-based active-link
// highlighting is needed here (this bar only ever has two links, both
// always visible; components/projects/ProjectSubNav.tsx is where
// active-tab highlighting actually matters).

import Link from "next/link";
import { SignOutButton } from "./SignOutButton";

export function TopBar({ userEmail }: { userEmail: string | null }) {
  return (
    <header className="topbar">
      <Link href="/projects" className="topbar-brand">
        RAG-ассистент
      </Link>
      <nav className="topbar-nav" aria-label="Основная навигация">
        <Link href="/projects" className="topbar-nav-link">
          Мои проекты
        </Link>
        <Link href="/profile" className="topbar-nav-link">
          Профиль
        </Link>
      </nav>
      <div className="topbar-user">
        <span className="field-hint" title={userEmail ?? undefined}>
          {userEmail ?? "Гость"}
        </span>
        <SignOutButton />
      </div>
    </header>
  );
}
