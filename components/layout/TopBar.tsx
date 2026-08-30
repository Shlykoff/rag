// components/layout/TopBar.tsx
//
// Account-level app shell nav (app/(app)/layout.tsx), replacing the old
// full-height conversation sidebar (components/layout/Sidebar.tsx,
// pre-projects-pivot). Conversation history is no longer a global concept
// -- it's scoped inside ONE project's own chat section now (see
// components/chat/ChatHistoryPanel.tsx) -- so this shell only needs three
// things every page under app/(app)/** shares regardless of which project
// (if any) is open: a way back to "Мои проекты", a way to account-level
// "Профиль", and who's signed in / sign out.
//
// A plain Server Component (no "use client") -- it renders no interactive
// state of its own beyond the already-client SignOutButton, so it doesn't
// need usePathname()-based active-link highlighting the way the old
// Sidebar did (this bar only ever has two links, both always visible; the
// per-project sub-nav -- components/projects/ProjectSubNav.tsx -- is where
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
