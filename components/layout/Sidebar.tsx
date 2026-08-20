"use client";

// Client component so it can highlight the active conversation
// (usePathname) and manage an open/closed state for the mobile
// hamburger toggle -- the conversation list itself is fetched
// server-side (app/(app)/layout.tsx) and passed down as plain props, so
// no extra client-side fetch/loading state is needed here.

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SignOutButton } from "./SignOutButton";

export interface ConversationSummary {
  id: string;
  title: string | null;
}

export interface SidebarProps {
  conversations: ConversationSummary[];
  userEmail: string | null;
  aiProviderLabel: string;
}

export function Sidebar({ conversations, userEmail, aiProviderLabel }: SidebarProps) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Closed explicitly from each nav Link's own onClick below (not a
  // pathname-watching useEffect) -- calling setState synchronously inside
  // an effect body triggers an extra cascading render for every
  // navigation, which react-hooks/set-state-in-effect flags; a click
  // handler achieves the same "drawer closes when you pick something"
  // behavior without it.
  function closeMobileDrawer() {
    setMobileOpen(false);
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-secondary sidebar-toggle"
        onClick={() => setMobileOpen((v) => !v)}
        aria-expanded={mobileOpen}
        aria-controls="app-sidebar"
      >
        <span aria-hidden="true">☰</span>
        <span>Меню</span>
      </button>

      {mobileOpen ? (
        <div
          className="sidebar-backdrop"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      ) : null}

      <nav
        id="app-sidebar"
        className={`sidebar${mobileOpen ? " sidebar-open" : ""}`}
        aria-label="Навигация по диалогам и документам"
      >
        <div className="sidebar-header">
          <Link href="/" className="sidebar-brand" onClick={closeMobileDrawer}>
            RAG-ассистент
          </Link>
        </div>

        <div className="sidebar-actions">
          <Link href="/" className="btn btn-primary" style={{ width: "100%" }} onClick={closeMobileDrawer}>
            + Новый диалог
          </Link>
          <Link
            href="/sources"
            className={`btn btn-secondary${pathname === "/sources" ? " btn-active" : ""}`}
            style={{ width: "100%" }}
            onClick={closeMobileDrawer}
          >
            Документы и источники
          </Link>
          <Link
            href="/profile"
            className={`btn btn-secondary${pathname === "/profile" ? " btn-active" : ""}`}
            style={{ width: "100%" }}
            onClick={closeMobileDrawer}
          >
            AI-провайдер
          </Link>
        </div>

        <div className="sidebar-history">
          <h2 className="sidebar-section-title">История диалогов</h2>
          {conversations.length === 0 ? (
            <p className="field-hint" style={{ padding: "0 0.9rem" }}>
              Пока нет ни одного диалога — начните новый вопрос выше.
            </p>
          ) : (
            <ul>
              {conversations.map((conversation) => {
                const isActive = pathname === `/chat/${conversation.id}`;
                return (
                  <li key={conversation.id}>
                    <Link
                      href={`/chat/${conversation.id}`}
                      className={`sidebar-conversation-link${isActive ? " sidebar-conversation-link-active" : ""}`}
                      onClick={closeMobileDrawer}
                    >
                      {conversation.title?.trim() || "Без названия"}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="sidebar-footer">
          <p className="field-hint">
            Работает на: <strong>{aiProviderLabel}</strong>{" "}
            <Link href="/profile" style={{ textDecoration: "underline" }} onClick={closeMobileDrawer}>
              настроить
            </Link>
          </p>
          <div className="sidebar-footer-row">
            <span className="field-hint" title={userEmail ?? undefined}>
              {userEmail ?? "Гость"}
            </span>
            <SignOutButton />
          </div>
        </div>
      </nav>
    </>
  );
}
