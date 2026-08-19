import { redirect } from "next/navigation";
import { getAuthenticatedUser, getRouteHandlerSupabaseClient } from "@/lib/supabase/server-client";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  // Defense in depth: proxy.ts already redirects an authenticated
  // visitor away from /login, but a Server Component render is cheap
  // insurance against that matcher ever being misconfigured.
  const supabase = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(supabase);
  if (user) {
    redirect("/");
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1.5rem",
      }}
    >
      <div style={{ width: "100%", maxWidth: "26rem" }}>
        <div style={{ textAlign: "center", marginBottom: "1.75rem" }}>
          <h1 style={{ fontSize: "1.5rem", fontWeight: 700 }}>RAG-ассистент</h1>
          <p style={{ color: "var(--foreground-muted)", marginTop: "0.4rem", fontSize: "0.92rem" }}>
            Задавайте вопросы по своим документам — файлам, страницам Notion,
            публичным ссылкам и папкам Google Drive.
          </p>
        </div>
        <div className="card">
          <LoginForm />
        </div>
      </div>
    </main>
  );
}
