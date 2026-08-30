import Link from "next/link";

// Rendered when app/(app)/projects/[projectId]/layout.tsx's ownership
// check calls notFound() -- covers both "no such project" and "belongs to
// another user" (deliberately identical, see that layout's own comment).
//
// THREE SEPARATE BUGS WERE FOUND AND FIXED TO MAKE THIS ACTUALLY WORK --
// all verified live (two real users, `next dev` AND a production
// `next build && next start`), not by code reading. This is a genuinely
// easy class of bug to reintroduce by accident (any new `loading.tsx`
// added above a segment that can `notFound()` risks the same status-code
// regression) -- read this in full before adding one.
//
// 1. FILE PLACEMENT: this file MUST live here (one segment UP from
//    [projectId]/), not colocated inside app/(app)/projects/[projectId]/
//    itself. A Next.js App Router `notFound()` thrown from inside a
//    layout.tsx cannot be caught by a not-found.tsx in that SAME segment
//    folder, because rendering that sibling file would require the very
//    layout that just failed (chicken-and-egg) -- it silently falls
//    through to Next's generic, unbranded built-in 404 instead. A
//    not-found.tsx in the PARENT segment (here) is available precisely
//    because it doesn't depend on the failing child layout to render. See
//    https://nextjs.org/docs/app/api-reference/file-conventions/not-found.
//    Fixing ONLY this got the branded UI rendering correctly, but --
// 2. HTTP STATUS CODE FOR [projectId]/layout.tsx's OWN notFound(): the
//    response status was STILL a bare 200, not 404, even with the branded
//    UI now rendering in the right place. Root cause: `loading.tsx` at ANY
//    ancestor segment of [projectId]/ (app/(app)/loading.tsx AND
//    app/(app)/projects/loading.tsx -- both now deleted, see
//    app/(app)/projects/page.tsx's own header comment for
//    app/(app)/projects/loading.tsx's replacement) creates a React
//    Suspense boundary that also wraps the sibling [projectId] route tree.
//    Next.js can flush that ancestor boundary's fallback -- locking the
//    HTTP response status at 200 -- BEFORE [projectId]/layout.tsx's own
//    async ownership check has even run, making a real 404 status
//    impossible for its notFound() call no matter where not-found.tsx
//    itself lives. Fixed by deleting both ancestor loading.tsx files.
//    app/(app)/projects/[projectId]/loading.tsx ITSELF was originally kept
//    at this point (it wraps only [projectId]/layout.tsx's OWN children,
//    not the layout's own top-level logic, so it's provably safe for
//    THIS layout's own notFound()) -- but see bug 3, which is exactly why
//    that file no longer exists either.
// 3. HTTP STATUS CODE FOR notFound() THROWN BY A DESCENDANT PAGE (not this
//    layout): chat/[conversationId]/page.tsx and
//    channels/[conversationId]/page.tsx each call their own notFound()
//    (stale/deleted conversation link within a project the caller DOES
//    own -- a different, narrower scenario than 1-2 above, which are about
//    a whole project the caller doesn't own). Fixing 1-2 did NOT fix this
//    one: the SAME bare-200 symptom reappeared for these two pages
//    specifically. Root cause, confirmed live by testing each ancestor
//    loading.tsx in isolation: `app/(app)/projects/[projectId]/loading.tsx`
//    -- safe for THIS layout's OWN notFound() (bug 2) -- is UNSAFE as an
//    ancestor of a DESCENDANT page's notFound(), because it wraps
//    `{children}`, and the failing pages are exactly that "children"
//    subtree; so is a same-segment `loading.tsx` directly above a PAGE
//    (not a layout) that itself throws notFound() -- unlike a layout, a
//    page has no "runs before its own segment's Suspense boundary" safety
//    property, since there's no `{children}` for loading.tsx to wrap
//    instead of the page itself.
//    Fix, in two parts:
//      a) chat/(list)/ and channels/(list)/ are Next.js route groups
//         (parentheses -- no URL segment added) that isolate each
//         section's OWN loading.tsx (moved from chat/loading.tsx and
//         channels/loading.tsx respectively) to ONLY that section's list
//         page (`/chat`, `/channels`) -- chat/[conversationId]/page.tsx and
//         channels/[conversationId]/page.tsx are siblings OUTSIDE those
//         groups, so they're never wrapped by them. This fully preserves
//         the loading skeleton for the list views with zero status-code
//         risk, since [conversationId] never shared a Suspense boundary
//         with them to begin with.
//      b) app/(app)/projects/[projectId]/loading.tsx itself is DELETED
//         (not scoped via a route group at the [projectId]/ level): a
//         route-group split at that level would need "chat" to be defined
//         partly through a group (for the list) and partly as a plain
//         top-level folder (for [conversationId]) for the SAME URL
//         segment -- not a structure Next.js's routing supports, so this
//         is the pragmatic fallback, not a missed surgical option. Its
//         real cost turns out to be small: every leaf route it used to
//         cover already has (or, after (a), now has) its own more
//         specific loading.tsx -- documents/loading.tsx, model/loading.tsx,
//         chat/(list)/loading.tsx, channels/(list)/loading.tsx -- and
//         React shows the INNERMOST pending Suspense boundary's fallback,
//         not an outer one, whenever both exist. The only routes that
//         genuinely lose a skeleton are chat/[conversationId] and
//         channels/[conversationId] themselves (the two pages that need
//         this fix) -- not documents/model/chat-list/channels-list, which
//         keep theirs untouched.
//
// This one file now genuinely serves TWO scenarios (bug 3 above added the
// second one) -- copy below is deliberately worded to cover both honestly
// rather than only naming "project": a whole project the caller doesn't
// own/that doesn't exist (bugs 1-2), or a specific
// conversation/transcript link that's stale/deleted/not theirs within a
// project they DO own (bug 3).
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
