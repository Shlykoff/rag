import { redirect } from "next/navigation";

// app/(app)/page.tsx
//
// Projects architecture pivot: the bare app root used to BE the "start a
// new chat" screen (ChatView with no conversationId) -- that assumed one
// flat document set/chat per account, which no longer holds true (see
// CLAUDE.md's "Context"). /projects (list/create/rename/delete projects)
// is the natural landing page now: an account's chat lives under
// /projects/[projectId]/chat, scoped to whichever project the user opens.
// This route is kept (rather than deleted) purely so "/" -- which
// proxy.ts's already-authenticated-visiting-/login redirect and
// app/login/LoginForm.tsx's post-sign-in navigation both still target --
// lands somewhere real instead of a 404.
export const dynamic = "force-dynamic";

export default function RootPage() {
  redirect("/projects");
}
