import Link from "next/link";

// Rendered when app/(app)/projects/[projectId]/layout.tsx's ownership
// check calls notFound() -- covers both "no such project" and "belongs to
// another user" (deliberately identical, see that layout's own comment).
//
// TWO SEPARATE BUGS WERE FIXED TO MAKE THIS ACTUALLY WORK -- both verified
// live (two real users, `next dev` AND a production `next build && next
// start`), not by code reading:
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
// 2. HTTP STATUS CODE: the response status was STILL a bare 200, not 404,
//    even with the branded UI now rendering in the right place. Root
//    cause: `loading.tsx` at ANY ancestor segment of [projectId]/ (both
//    app/(app)/loading.tsx AND this same app/(app)/projects/loading.tsx --
//    now deleted, see app/(app)/projects/page.tsx's own header comment for
//    its replacement) creates a React Suspense boundary that also wraps
//    the sibling [projectId] route tree. Next.js can flush that ancestor
//    boundary's fallback -- locking the HTTP response status at 200 --
//    BEFORE [projectId]/layout.tsx's own async ownership check has even
//    run, making a real 404 status impossible for its notFound() call no
//    matter where not-found.tsx itself lives. Fixed by deleting both
//    ancestor loading.tsx files (app/(app)/projects/[projectId]/loading.tsx
//    itself, and everything below it, is fine to keep -- it wraps only
//    [projectId]/layout.tsx's OWN children, not the layout's own top-level
//    logic, and was verified compatible with a real 404 throughout).
export default function ProjectNotFound() {
  return (
    <div style={{ padding: "2rem", maxWidth: "32rem", margin: "3rem auto" }}>
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <h2 style={{ fontSize: "1.1rem" }}>Проект не найден</h2>
        <p className="field-hint">
          Такого проекта не существует, либо он вам не принадлежит. Возможно, он был удалён в другой
          вкладке.
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
