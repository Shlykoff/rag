import { redirect } from "next/navigation";

// Redirects to /projects, the landing page for a signed-in account. Kept
// as a route (rather than deleted) so "/" -- which proxy.ts's
// already-authenticated-visiting-/login redirect and
// app/login/LoginForm.tsx's post-sign-in navigation both target -- lands
// somewhere real instead of a 404.
export const dynamic = "force-dynamic";

export default function RootPage() {
  redirect("/projects");
}
