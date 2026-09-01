import Link from "next/link";

// Rendered when app/(app)/projects/[projectId]/layout.tsx's ownership
// check calls notFound() -- covers both "no such project" and "belongs to
// another user" (deliberately identical, see that layout's own comment).
// Also covers a stale/deleted conversation link within a project the
// caller DOES own: chat/[conversationId]/page.tsx and
// channels/[conversationId]/page.tsx call their own notFound() for that
// narrower case, which is why the copy below doesn't only mention
// "project".
//
// This file's placement, and the absence of certain loading.tsx files,
// depend on two Next.js App Router constraints that are easy to break by
// accident -- read before adding a new loading.tsx above a segment that
// can notFound():
//
// 1. This file must live here, ONE SEGMENT UP from [projectId]/, not
//    colocated inside it. A notFound() thrown from a layout.tsx can't be
//    caught by a not-found.tsx in that same segment folder, because
//    rendering that sibling file would require the very layout that just
//    failed (chicken-and-egg) -- it would silently fall through to Next's
//    generic, unbranded built-in 404 instead. See
//    https://nextjs.org/docs/app/api-reference/file-conventions/not-found.
//
// 2. No loading.tsx at any ancestor of a segment that can notFound() --
//    this rules out loading.tsx directly on [projectId]/ itself, and on
//    chat/ or channels/ above their own [conversationId] pages. An
//    ancestor loading.tsx creates a Suspense boundary that wraps the whole
//    subtree below it, and Next.js can flush that boundary's fallback --
//    locking the HTTP response status at 200 -- before the notFound() call
//    further down has even run, making a real 404 status impossible no
//    matter where not-found.tsx itself lives. This is why chat/ and
//    channels/ each split their list page into a `(list)` route group with
//    its own loading.tsx, scoped to only that list page and never the
//    sibling [conversationId] page (see chat/layout.tsx), and why
//    app/(app)/projects/page.tsx builds its own loading skeleton from a
//    Suspense boundary in JSX instead of a loading.tsx file.
export default function ProjectNotFound() {
  return (
    <div style={{ padding: "2rem", maxWidth: "32rem", margin: "3rem auto" }}>
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <h2 style={{ fontSize: "1.1rem" }}>Страница не найдена</h2>
        <p className="field-hint">
          Запрошенный проект или диалог не существует, либо у вас нет к нему доступа. Возможно, он
          был удалён в другой вкладке.
        </p>
        <div>
          <Link href="/projects" className="btn btn-primary">
            Вернуться к моим проектам
          </Link>
        </div>
      </div>
    </div>
  );
}
